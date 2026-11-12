// The tool-facing type vocabulary, kept minimal on purpose.
//
// DSH's `ToolDefinition` is what `ctx.tools.register()` accepts. This mirror exists so
// the plugin compiles without importing `@deepseek-ai/dsh-tools` (which a profile-installed
// bundle cannot resolve), while still describing the exact shape the Host enforces:
// `name`, `description`, raw JSON-Schema `parameters`, and a mandatory
// `output: { schema, render }`.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ToolParamsSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolRunContext {
  readonly signal: AbortSignal;
  readonly agent?: unknown;
  readonly callId?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParamsSchema;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: JsonValue): Array<{ type: string; text?: string }>;
  };
  timeoutMs?: number;
  isConcurrencySafe?(args: unknown): boolean;
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>;
  presentCall?(args: unknown): unknown;
  presentResult?(args: unknown, result: unknown): unknown;
}

export interface ToolsService {
  register(definition: ToolDefinition): () => void;
  restrict(filter: { allow?: string[]; deny?: string[] }): () => void;
  get(name: string, scope?: unknown): ToolDefinition | undefined;
  schemas(scope?: unknown): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

export interface SubagentsService {
  registerProvider(provider: {
    name: string;
    capabilities: { agentOptions: boolean; agentPreset: boolean; outputSchema: boolean; depthLimit: boolean };
    inheritsParentContext: boolean;
    start?(request: unknown): Promise<unknown>;
  }): () => void;
  getProvider(name: string): unknown;
  list(): string[];
}

export interface Logger {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
  debug?(message: string, ...rest: unknown[]): void;
}

export interface SystemPromptService {
  section(section: { name: string; order?: number; text: (context?: unknown) => string }): () => void;
  context(context: { name: string; order?: number; text: (context?: unknown) => string }): () => void;
}

/** The subset of the Cordis plugin context dsh-mesh uses. */
export interface MeshContext {
  tools?: ToolsService;
  subagents?: SubagentsService;
  agents?: unknown;
  systemPrompt?: SystemPromptService;
  logger: Logger;
  get(name: string): unknown;
  effect(dispose: () => void | Promise<void>): () => void;
  on?(name: string, listener: (...args: never[]) => void, options?: { global?: boolean }): () => void;
  emit?(name: string): void;
}
