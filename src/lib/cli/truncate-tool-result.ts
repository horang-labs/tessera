import logger from '../logger';

const MAX_RESULT_SIZE = 102400;  // 100KB
const FIELD_TRUNCATION_LIMIT = 50000;  // 50KB per field
const TRUNCATION_SUFFIX = '\n[... truncated ...]';

const TOP_LEVEL_TEXT_FIELDS = ['stdout', 'stderr', 'fullOutput', 'content', 'result', 'beforeText', 'afterText', 'responseText'] as const;

export function truncateToolResult(result: any, context?: { sessionId?: string; toolName?: string }): any {
  if (result === undefined || result === null) {
    return undefined;
  }

  // String -> error message, pass through unmodified
  if (typeof result === 'string') {
    return result;
  }

  // Non-object types -> invalid, warn and discard
  if (typeof result !== 'object' || Array.isArray(result)) {
    logger.warn({
      sessionId: context?.sessionId,
      toolName: context?.toolName,
      actualType: typeof result,
      isArray: Array.isArray(result),
      }, 'Invalid toolUseResult type');
    return undefined;
  }

  // Check serialized size
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    logger.warn({
      sessionId: context?.sessionId,
      toolName: context?.toolName,
      }, 'toolUseResult not serializable');
    return undefined;
  }

  if (serialized.length <= MAX_RESULT_SIZE) {
    return result;
  }

  // Truncate specific large fields
  const truncated = { ...result, _truncated: true };

  for (const field of TOP_LEVEL_TEXT_FIELDS) {
    if (field in truncated && typeof truncated[field] === 'string' && truncated[field].length > FIELD_TRUNCATION_LIMIT) {
      truncated[field] = truncated[field].substring(0, FIELD_TRUNCATION_LIMIT) + TRUNCATION_SUFFIX;
    }
  }

  // Nested: file.content (ReadTextToolResult)
  if (truncated.file?.content && typeof truncated.file.content === 'string' && truncated.file.content.length > FIELD_TRUNCATION_LIMIT) {
    truncated.file = {
      ...truncated.file,
      content: truncated.file.content.substring(0, FIELD_TRUNCATION_LIMIT) + TRUNCATION_SUFFIX,
    };
  }

  if (truncated.task?.output && typeof truncated.task.output === 'string' && truncated.task.output.length > FIELD_TRUNCATION_LIMIT) {
    truncated.task = {
      ...truncated.task,
      output: truncated.task.output.substring(0, FIELD_TRUNCATION_LIMIT) + TRUNCATION_SUFFIX,
    };
  }

  // Nested: filenames array (GlobToolResult)
  if (Array.isArray(truncated.filenames) && truncated.filenames.length > 500) {
    truncated.filenames = truncated.filenames.slice(0, 500);
  }

  const truncatedSize = JSON.stringify(truncated).length;

  logger.info({
    sessionId: context?.sessionId,
    toolName: context?.toolName,
    originalSize: serialized.length,
    truncatedSize,
    }, 'toolUseResult truncated');

  return truncated;
}
