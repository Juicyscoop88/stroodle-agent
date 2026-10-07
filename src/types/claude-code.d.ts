declare module "@anthropic-ai/claude-code" {
  interface RunOptions {
    prompt: string;
    cwd?: string;
  }
  interface Message {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }
  export const Claude: {
    run(options: RunOptions): Promise<Message[]>;
  };
}
