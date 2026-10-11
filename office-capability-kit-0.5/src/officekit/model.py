"""Public, provider-neutral candidate/result types; no SDK or credential access."""
from dataclasses import dataclass, field
from typing import Any, Protocol

STATUSES = ("PASS", "FAIL", "UNKNOWN")
ERROR_CLASSES = ("BUSINESS_FACT", "FUNCTIONAL_RESULT", "PROTOCOL_INTEGRATION", "SAFETY_EFFECT", "INSTRUMENTATION", "UNKNOWN_SOURCE")

@dataclass(frozen=True)
class CandidateResult:
    artifacts: list[str] = field(default_factory=list)
    completed_actions: list[dict[str, Any]] = field(default_factory=list)
    facts: dict[str, Any] = field(default_factory=dict)
    text: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"artifacts": self.artifacts, "completed_actions": self.completed_actions, "facts": self.facts, "text": self.text}

@dataclass(frozen=True)
class ProviderInfo:
    name: str
    kind: str
    is_live_model: bool = False
    live_capability: str = "UNKNOWN"
    requested_backend: str = "UNKNOWN"
    verified_backend: str = "LOCAL_FIXTURE_RUNTIME"
    requested_model: str = "UNKNOWN"
    verified_model: str = "UNKNOWN"
    requested_snapshot: str = "UNKNOWN"
    verified_snapshot: str = "UNKNOWN"
    requested_effort: str = "UNKNOWN"
    verified_effort: str = "UNKNOWN"

class CandidateSession(Protocol):
    """The candidate receives public prompt/inputs/tool descriptions only."""
    case_id: str
    prompt: str
    tool_descriptions: dict[str, Any]
    def call(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]: ...

class Provider(Protocol):
    info: ProviderInfo
    def execute(self, session: CandidateSession) -> CandidateResult: ...

class UnconfiguredLiveProvider:
    """Interface skeleton. Never reads credentials or sends network requests."""
    info = ProviderInfo("unconfigured-live-interface", "interface-only", verified_backend="UNKNOWN")
    def execute(self, session: CandidateSession) -> CandidateResult:
        raise NotImplementedError("Live provider is unconfigured and untested; live capability remains UNKNOWN.")
