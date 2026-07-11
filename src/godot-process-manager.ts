import { spawn, type ChildProcess } from 'child_process';

export interface GodotProcess {
  process: ChildProcess;
  output: string[];
  errors: string[];
}

export interface StartGodotProcessOptions {
  executable: string;
  args: string[];
  onExit?: (code: number | null) => void;
  onError?: (error: Error) => void;
}

/** Owns the active Godot child process and its captured output. */
export class GodotProcessManager {
  public activeProcess: GodotProcess | null = null;
  private lastErrorIndex = 0;
  private lastLogIndex = 0;

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  get active(): boolean {
    return this.activeProcess !== null;
  }

  start(options: StartGodotProcessOptions): GodotProcess {
    const child = spawn(options.executable, options.args, { stdio: 'pipe' });
    const record: GodotProcess = { process: child, output: [], errors: [] };
    this.activeProcess = record;
    this.resetCursors();

    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      record.output.push(...lines);
      for (const line of lines) if (line.trim()) this.log(`[Godot stdout] ${line}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      record.errors.push(...lines);
      for (const line of lines) if (line.trim()) this.log(`[Godot stderr] ${line}`);
    });
    child.on('exit', (code: number | null) => {
      this.log(`Godot process exited with code ${code}`);
      if (this.activeProcess?.process === child) this.activeProcess = null;
      options.onExit?.(code);
    });
    child.on('error', (error: Error) => {
      if (this.activeProcess?.process === child) this.activeProcess = null;
      options.onError?.(error);
    });
    return record;
  }

  stop(): GodotProcess | null {
    const record = this.activeProcess;
    if (!record) return null;
    this.activeProcess = null;
    this.resetCursors();
    record.process.kill();
    return record;
  }

  seedActiveProcess(process: GodotProcess | null): void {
    this.activeProcess = process;
  }

  readNewErrors(): string[] {
    if (!this.activeProcess) return [];
    const errors = this.activeProcess.errors.slice(this.lastErrorIndex);
    this.lastErrorIndex = this.activeProcess.errors.length;
    return errors;
  }

  readNewLogs(): string[] {
    if (!this.activeProcess) return [];
    const logs = this.activeProcess.output.slice(this.lastLogIndex);
    this.lastLogIndex = this.activeProcess.output.length;
    return logs;
  }

  private resetCursors(): void {
    this.lastErrorIndex = 0;
    this.lastLogIndex = 0;
  }
}
