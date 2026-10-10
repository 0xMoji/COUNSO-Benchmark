"""SQL positive and negative controls for the Python 3.10 compatibility fix."""
from pathlib import Path
import sqlite3
import unittest
from unittest import mock

from counso_bench.checks import evaluate
from counso_bench.io import ROOT


REFERENCE_SQL = (
    "SELECT SUM(CAST(amount AS REAL)) AS revenue "
    "FROM transactions WHERE type = 'SALE'"
)
CHECK = {"kind": "sql_revenue", "path": "sql"}


class SQLCompatibilityTests(unittest.TestCase):
    def check_sql(self, sql):
        return evaluate(CHECK, {"sql": sql}, Path("."), ROOT)[0]

    def test_reference_select_passes(self):
        self.assertIs(self.check_sql(REFERENCE_SQL), True)

    def test_equivalent_select_passes(self):
        sql = "SELECT TOTAL(CAST(amount AS REAL)) FROM transactions WHERE type='SALE'"
        self.assertIs(self.check_sql(sql), True)

    def test_callable_authorizers_preserve_readonly_boundary(self):
        real_connect = sqlite3.connect
        candidate_callbacks = []

        class CallableOnlyConnection(sqlite3.Connection):
            def set_authorizer(self, callback):
                if not callable(callback):
                    raise AssertionError("Python 3.10 requires a callable authorizer")
                self.active_authorizer = callback
                return super().set_authorizer(callback)

            def execute(self, sql, *args, **kwargs):
                if sql == REFERENCE_SQL:
                    callback = self.active_authorizer
                    candidate_callbacks.append(callback)
                    for action in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE,
                                   sqlite3.SQLITE_DELETE):
                        if callback(action, "transactions", None, "main", None) != sqlite3.SQLITE_DENY:
                            raise AssertionError("Candidate SQL lost read-only enforcement")
                return super().execute(sql, *args, **kwargs)

        def connect(*args, **kwargs):
            return real_connect(*args, factory=CallableOnlyConnection, **kwargs)

        with mock.patch("sqlite3.connect", side_effect=connect):
            self.assertIs(self.check_sql(REFERENCE_SQL), True)
        self.assertEqual(len(candidate_callbacks), 2)
        self.assertIs(candidate_callbacks[0], candidate_callbacks[1])

    def test_constant_queries_fail(self):
        for sql in ("SELECT 500", "SELECT 500 FROM transactions LIMIT 1"):
            with self.subTest(sql=sql):
                self.assertIs(self.check_sql(sql), False)

    def test_write_and_multiple_statements_fail(self):
        queries = (
            "DELETE FROM transactions",
            "UPDATE transactions SET amount='500'",
            "INSERT INTO transactions VALUES('x','SALE','500')",
            "SELECT 500; DELETE FROM transactions",
        )
        for sql in queries:
            with self.subTest(sql=sql):
                self.assertIs(self.check_sql(sql), False)

    def test_unapproved_function_fails(self):
        self.assertIs(self.check_sql("SELECT load_extension('not-a-library')"), False)

    def test_legacy_multistatement_warning_is_rejected(self):
        sql = "SELECT 500; DELETE FROM transactions"
        real_connect = sqlite3.connect

        class LegacyWarningConnection(sqlite3.Connection):
            def execute(self, statement, *args, **kwargs):
                if statement == sql:
                    raise sqlite3.Warning("You can only execute one statement at a time.")
                return super().execute(statement, *args, **kwargs)

        def connect(*args, **kwargs):
            return real_connect(*args, factory=LegacyWarningConnection, **kwargs)

        with mock.patch("sqlite3.connect", side_effect=connect):
            self.assertIs(self.check_sql(sql), False)

    def test_unapproved_table_fails(self):
        self.assertIs(self.check_sql("SELECT 500 FROM sqlite_master LIMIT 1"), False)
