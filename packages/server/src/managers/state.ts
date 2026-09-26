/**
 * ManagersState — the one app-wide bundle of Managers domain stores.
 *
 * Built once in `app.ts` and shared by the REST routes (M4) and the state ops
 * (M5), so every reader goes through the same mtime caches. The caches key on
 * absolute paths, so one instance serves every workspace.
 */
import { EpisodesStore } from "./episodes-store.js";
import { ObjectivesStore } from "./objectives-store.js";
import { TasksStore } from "./tasks-store.js";
import { MemoryStore } from "./memory-store.js";
import { RunsStore } from "./runs-store.js";
import { ReportsStore } from "./reports-store.js";
import { sharedMemoryLayout, workspaceLayout, type WorkspaceLayout } from "./layout.js";

export class ManagersState {
  readonly episodes = new EpisodesStore();
  readonly objectives = new ObjectivesStore(this.episodes);
  readonly tasks = new TasksStore();
  readonly memory = new MemoryStore();
  readonly runs = new RunsStore();
  readonly reports = new ReportsStore();

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
