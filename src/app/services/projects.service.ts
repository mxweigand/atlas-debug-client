import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AtlasObject, AtlasProject } from '../protocol/messages';

export interface ProjectDetail {
  project: AtlasProject;
  objects: AtlasObject[];
}

/**
 * Debug-client view of the server's project registry. REST calls hit the
 * atlas-server HTTP surface (default port 3000). Live state — active project,
 * project list, object patches — is mirrored into signals so the UI can react
 * without manual subscriptions.
 *
 * The active project mirror is authoritative from the server side: whenever
 * we receive a `project_activated` monitor event, we reload the detail so we
 * pick up any out-of-band file edits. The `object_updated` monitor event
 * patches individual objects in place.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsService {
  private http = inject(HttpClient);

  private restBase = 'http://localhost:3000';

  readonly projects = signal<AtlasProject[]>([]);
  readonly active = signal<ProjectDetail | null>(null);

  setRestBase(url: string): void {
    this.restBase = url.replace(/\/$/, '');
  }

  async refreshList(): Promise<void> {
    const list = await firstValueFrom(this.http.get<AtlasProject[]>(`${this.restBase}/projects`));
    this.projects.set(list);
  }

  async activate(projectId: string): Promise<void> {
    const detail = await firstValueFrom(
      this.http.post<ProjectDetail>(`${this.restBase}/projects/${projectId}/activate`, {}),
    );
    this.active.set(detail);
  }

  async deactivate(): Promise<void> {
    await firstValueFrom(this.http.post(`${this.restBase}/projects/deactivate`, {}));
    this.active.set(null);
  }

  async reloadActive(projectId: string): Promise<void> {
    const detail = await firstValueFrom(
      this.http.get<ProjectDetail>(`${this.restBase}/projects/${projectId}`),
    );
    this.active.set(detail);
  }

  /** Apply an incoming object_updated broadcast to the active project in place. */
  applyObjectUpdate(projectId: string, object: AtlasObject): void {
    const current = this.active();
    if (!current || current.project.id !== projectId) return;
    this.active.set({
      project: current.project,
      objects: current.objects.map((o) => (o.id === object.id ? object : o)),
    });
  }
}
