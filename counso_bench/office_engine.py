"""Optional, bounded LibreOffice execution without a Python package dependency.

COUNSO_SOFFICE may name an executable; otherwise PATH is searched. This engine
is a second calculation/rendering implementation, not an Excel compatibility
claim. Temporary input, output and a fresh user profile are removed on exit.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile

from .io import BenchError
from .office_package import read_office_parts


class OfficeEngineError(BenchError):
    """An optional engine could not establish a result; record UNKNOWN."""


class OfficeEngineUnavailable(OfficeEngineError):
    pass


@dataclass(frozen=True)
class OfficeConversion:
    path: Path
    engine_version: str
    output_format: str


def find_engine():
    configured = os.environ.get('COUNSO_SOFFICE', '').strip()
    executable = shutil.which(configured) if configured else (shutil.which('soffice') or shutil.which('libreoffice'))
    if not executable:
        raise OfficeEngineUnavailable('未找到可选LibreOffice引擎；设置COUNSO_SOFFICE或将soffice加入PATH')
    return executable


def _run(command, *, cwd, timeout_seconds):
    if not 0 < timeout_seconds <= 120:
        raise OfficeEngineError('Office引擎超时必须在0到120秒之间')
    try:
        process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    except OSError as exc:
        raise OfficeEngineUnavailable('Office引擎无法启动') from exc
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired as exc:
        try:
            if hasattr(os, 'killpg'):
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        process.communicate(timeout=5)
        raise OfficeEngineError('Office引擎执行超时') from exc
    if process.returncode:
        raise OfficeEngineError('Office引擎执行失败，退出码' + str(process.returncode))
    return stdout.decode('utf-8', errors='replace')[:4000], stderr.decode('utf-8', errors='replace')[:4000]


@contextmanager
def convert_office(path, output_format, timeout_seconds=30):
    path = Path(path)
    if path.suffix.lower() not in {'.xlsx', '.pptx'}:
        raise OfficeEngineError('可选Office引擎只接受XLSX/PPTX')
    if output_format not in {'xlsx', 'pdf'} or (output_format == 'xlsx' and path.suffix.lower() != '.xlsx'):
        raise OfficeEngineError('Office转换格式不受支持')
    # Verify self-contained package input before invoking a consumer.
    read_office_parts(path)
    executable = find_engine()
    with tempfile.TemporaryDirectory(prefix='counso-office-') as directory:
        workspace = Path(directory)
        inputs, outputs, profile = workspace / 'input', workspace / 'output', workspace / 'profile'
        for folder in (inputs, outputs, profile):
            folder.mkdir()
        # The profile disallows macros; the package checker also rejects macros
        # and external relationships before this process is started.
        (profile / 'registrymodifications.xcu').write_text(
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
            '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
            '</item></oor:items>', encoding='utf-8')
        local_input = inputs / ('candidate' + path.suffix.lower())
        shutil.copyfile(path, local_input)
        version, _ = _run([executable, '--version'], cwd=workspace, timeout_seconds=min(timeout_seconds, 5))
        filter_name = 'xlsx:Calc MS Excel 2007 XML' if output_format == 'xlsx' else ('pdf:impress_pdf_Export' if path.suffix.lower() == '.pptx' else 'pdf:calc_pdf_Export')
        command = [executable, '-env:UserInstallation=' + profile.as_uri(), '--headless', '--norestore', '--nodefault', '--nolockcheck', '--convert-to', filter_name, '--outdir', str(outputs), str(local_input)]
        _run(command, cwd=workspace, timeout_seconds=timeout_seconds)
        output = outputs / ('candidate.' + output_format)
        if not output.is_file() or output.stat().st_size == 0 or output.stat().st_size > 50_000_000:
            raise OfficeEngineError('Office引擎未产生有效且有界的输出文件')
        if output_format == 'xlsx':
            try:
                read_office_parts(output)
            except BenchError as exc:
                raise OfficeEngineError('Office引擎输出的工作簿无法核验') from exc
        elif output.read_bytes()[:5] != b'%PDF-':
            raise OfficeEngineError('Office引擎输出不是PDF')
        yield OfficeConversion(output, version.strip()[:512], output_format)


@contextmanager
def recalculate(path, timeout_seconds=30):
    with convert_office(path, 'xlsx', timeout_seconds) as result:
        yield result


@contextmanager
def render_pdf(path, timeout_seconds=30):
    with convert_office(path, 'pdf', timeout_seconds) as result:
        yield result
