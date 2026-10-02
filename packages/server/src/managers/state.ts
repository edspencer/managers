/**
 * ManagersState — the one app-wide bundle of Managers domain stores.
 *
 * Built once in `app.ts` and shared by the REST routes (M4) and the state ops
 * (M5), so every reader goes through the same mtime caches, and every writer
 * through the same per-workspace write queue. The caches key on
 * absolute paths, so one instance serves every workspace.
 */
import { EpisodesStore } from "./episodes-store.js";
import { ObjectivesStore } from "./objectives-store.js";
import { TasksStore } from "./tasks-store.js";
import { MemoryStore } from "./memory-store.js";
import { RunsStore } from "./runs-store.js";
import { ReportsStore } from "./reports-store.js";
import { StateWriter } from "./state-writes.js";
import { ConsolidationTracker } from "./consolidation.js";
import { ChatTurnStore } from "./chat-turns.js";
import type { DataSyncStatus } from "./data-sync.js";
import { sharedMemoryLayout, workspaceLayout, type WorkspaceLayout } from "./layout.js";

export class ManagersState {
  readonly episodes = new EpisodesStore();
  readonly objectives = new ObjectivesStore(this.episodes);
  readonly tasks = new TasksStore();
  readonly memory = new MemoryStore();
  readonly runs = new RunsStore();
  readonly reports = new ReportsStore();
  /** Every write (MCP state tools and write REST) goes through this (M5). */
  readonly writer = new StateWriter(this.episodes, undefined, this.memory);
  /**
   * M14: the consolidation runs in flight in THIS process (the run marker that
   * unlocks `memory_op`) and the per-workspace early-fire claim.
   */
  readonly consolidations = new ConsolidationTracker();
  /** When each chat's previous human turn ran, for its next turn's delta (`chat-delta.ts`). */
  readonly chatTurns = new ChatTurnStore();

  /**
   * M15: the data-repo sync, when one is wired (app.ts). Home's alerts read its
   * status for `data-sync-failed`.
   */
  dataSync: { readonly status: DataSyncStatus; request?(): void } | null = null;

  constructor(readonly projectsRoot: string) {}

  /** The layout of the workspace whose directory is `dir`. */
  layout(dir: string): WorkspaceLayout {
    return workspaceLayout(dir);
  }

  /** The shared (root) memory layout. */
  get rootLayout(): WorkspaceLayout {
    return sharedMemoryLayout(this.projectsRoot);
  }
}
