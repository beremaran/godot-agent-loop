import { spawn, type ChildProcess } from 'child_process';
import {
  GODOT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  GODOT_PROCESS_LOG_LINE_LIMIT,
} from './godot-subprocess.js';

export interface GodotProcess {
  process: ChildProcess;
  output: string[];
  errors: string[];
}

export interface StartGodotProcessOptions {
  executable: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  onExit?: (code: number | null) => void;
  onError?: (error: Error) => void;
}

/** Owns the active Godot child process and its captured output. */
export class GodotProcessManager {
  public activeProcess: GodotProcess | null = null;
  private lastErrorIndex = 0;
  private lastLogIndex = 0;

  constructor(
    private readonly log: (message: string) => void = () => undefined,
    private readonly logLineLimit = GODOT_PROCESS_LOG_LINE_LIMIT,
    private readonly gracefulShutdownTimeoutMs = GODOT_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {}

  get active(): boolean {
    return this.activeProcess !== null;
  }

  start(options: StartGodotProcessOptions): GodotProcess {
    const child = this.spawnProcess(options.executable, options.args, {
      stdio: 'pipe',
      env: options.env === undefined ? undefined : { ...process.env, ...options.env },
    });
    const record: GodotProcess = { process: child, output: [], errors: [] };
    this.activeProcess = record;
    this.resetCursors();

    child.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      this.appendLines(record.output, lines, 'logs');
      for (const line of lines) if (line.trim()) this.log(`[Godot stdout] ${line}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n');
      this.appendLines(record.errors, lines, 'errors');
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
    let exited = false;
    const forceKill = setTimeout(() => {
      if (!exited) {
        this.log(`Godot process did not exit after ${this.gracefulShutdownTimeoutMs}ms; forcing termination`);
        record.process.kill('SIGKILL');
      }
    }, this.gracefulShutdownTimeoutMs);
    if (typeof record.process.on === 'function') {
      record.process.on('exit', () => {
        exited = true;
        clearTimeout(forceKill);
      });
    }
    record.process.kill('SIGTERM');
    return record;
  }

  seedActiveProcess(process: GodotProcess | null): void {
    this.activeProcess = process;
  }

  readNewErrors(limit = 1000): { items: string[]; remaining: number } {
    if (!this.activeProcess) return { items: [], remaining: 0 };
    const end = Math.min(this.lastErrorIndex + limit, this.activeProcess.errors.length);
    const items = this.activeProcess.errors.slice(this.lastErrorIndex, end);
    this.lastErrorIndex = end;
    return { items, remaining: this.activeProcess.errors.length - end };
  }

  readNewLogs(limit = 1000): { items: string[]; remaining: number } {
    if (!this.activeProcess) return { items: [], remaining: 0 };
    const end = Math.min(this.lastLogIndex + limit, this.activeProcess.output.length);
    const items = this.activeProcess.output.slice(this.lastLogIndex, end);
    this.lastLogIndex = end;
    return { items, remaining: this.activeProcess.output.length - end };
  }

  private resetCursors(): void {
    this.lastErrorIndex = 0;
    this.lastLogIndex = 0;
  }

  private appendLines(target: string[], lines: string[], stream: 'logs' | 'errors'): void {
    target.push(...lines);
    const excess = target.length - this.logLineLimit;
    if (excess > 0) {
      target.splice(0, excess);
      if (stream === 'logs') this.lastLogIndex = Math.max(0, this.lastLogIndex - excess);
      else this.lastErrorIndex = Math.max(0, this.lastErrorIndex - excess);
    }
  }
}
