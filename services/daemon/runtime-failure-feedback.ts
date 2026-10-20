import { ArtifactError } from './artifacts';
import { ProactiveError } from './proactive';
import { ShellError } from './shell';
import { DesktopError } from './desktop-protocol';
import type { RuntimeFailure } from './runtime';

const shellCodes=new Set(['shell_input_backpressure_retry_after_consumption','shell_input_failed','shell_input_required','shell_session_exited','shell_session_limit_close_unused_sessions','shell_session_unknown_or_expired','shell_signal_failed','shell_spawn_failed','aborted','empty_command','unknown_tool','mcp_pagination_cycle','mcp_schema_limit','mcp_tool_limit','mcp_tool_name_collision']);
const artifactCodes=new Set(['attachment_size_limit','attachment_transport_failed','attachment_integrity_failed','attachment_body_missing','publish_requires_task_output','publish_requires_regular_task_file','artifact_size_limit','artifact_changed_during_open','artifact_changed_during_read','publication_transport_failed','published_artifact_integrity_failed','checkpoint_artifact_scope_mismatch','checkpoint_artifact_directory_changed','checkpoint_attachment_changed']);
export function ordinaryToolCode(error:unknown):string|undefined {
  if(error instanceof ArtifactError)return artifactCodes.has(error.code)||/^(attachment|publication)_http_[1-5][0-9]{2}$/.test(error.code)?error.code:'artifact_operation_failed';
  if(error instanceof ProactiveError){const status=/^enrollment_http_([1-5][0-9]{2})_/.exec(error.code)?.[1];return status?`future_work_http_${status}`:error.code==='enrollment_transport_failed'?error.code:'future_work_operation_failed';}
  return error instanceof ShellError ? shellCodes.has(error.code)?error.code:'shell_execution_failed' : undefined;
}
export function fatalDesktopFailure(error:unknown):boolean {
  return error instanceof DesktopError && /cleanup|termination|guardian|barrier|input_release/.test(error.code);
}
function diagnostic(failure:RuntimeFailure) {
  const {event:_event,run_id:_runId,...details}=failure;
  return details;
}
export function toolFailureFeedback(call:{readonly toolName:string;readonly callId:string;readonly readOnly:boolean},failure:RuntimeFailure):string {
  return JSON.stringify({kind:'tool_execution_error',tool_name:call.toolName,call_id:call.callId,...diagnostic(failure),executed:true,effect_uncertain:!call.readOnly,
    retry_safety:call.readOnly?'read_only':'reconcile_before_retry',
    instruction:call.readOnly?'The tool failed. Use this failure to choose a corrected read-only request or explain the limitation.':'The tool failed after invocation and its effects are uncertain. Do not repeat this action. Inspect external state with read-only tools and reconcile before deciding what to do next.'});
}
export function runtimeFailureFeedback(failure:RuntimeFailure):string {
  return JSON.stringify({kind:'runtime_failure_feedback',...diagnostic(failure),instruction:'The previous execution stopped at this failure. This is harness feedback, not a new user request. Read the latest user input and completed tool history. Never replay completed or uncertain external effects; inspect and reconcile first.'});
}
