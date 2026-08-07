import type { ProjectCreatorUsage, ProjectFolderUsage, ProjectModelUsage } from "./types";

export interface ProjectSequenceUsage extends ProjectFolderUsage {
  sequence_name: string;
}

export interface ProjectEpisodeUsage extends ProjectFolderUsage {
  episode_name: string;
  sequences: ProjectSequenceUsage[];
}

function emptyEpisode(episodeName: string): ProjectEpisodeUsage {
  return {
    episode_name: episodeName,
    folder_path: episodeName,
    count: 0,
    final_count: 0,
    credits: 0,
    elapsed_seconds: 0,
    created_start: null,
    created_end: null,
    models: [],
    members: [],
    sequences: [],
  };
}

function mergeMembers(
  target: ProjectCreatorUsage[],
  source: ProjectCreatorUsage[],
): ProjectCreatorUsage[] {
  const merged = new Map<string, ProjectCreatorUsage>();
  for (const row of [...target, ...source]) {
    const current = merged.get(row.uid) || {
      uid: row.uid,
      name: row.name || "팀원",
      count: 0,
      credits: 0,
      final_count: 0,
    };
    current.name = row.name || current.name;
    current.count += row.count || 0;
    current.credits += row.credits || 0;
    current.final_count += row.final_count || 0;
    merged.set(row.uid, current);
  }
  return [...merged.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
}

function mergeModels(target: ProjectModelUsage[], source: ProjectModelUsage[]): ProjectModelUsage[] {
  const merged = new Map<string, ProjectModelUsage>();
  for (const row of [...target, ...source]) {
    const current = merged.get(row.model) || {
      model: row.model,
      count: 0,
      credits: 0,
      final_count: 0,
      elapsed_seconds: 0,
    };
    current.count += row.count || 0;
    current.credits += row.credits || 0;
    current.final_count += row.final_count || 0;
    current.elapsed_seconds = (current.elapsed_seconds || 0) + (row.elapsed_seconds || 0);
    merged.set(row.model, current);
  }
  return [...merged.values()].sort(
    (a, b) => b.credits - a.credits || b.count - a.count || a.model.localeCompare(b.model),
  );
}

function mergeFolderIntoEpisode(episode: ProjectEpisodeUsage, folder: ProjectFolderUsage): void {
  episode.count += folder.count || 0;
  episode.final_count += folder.final_count || 0;
  episode.credits += folder.credits || 0;
  episode.elapsed_seconds += folder.elapsed_seconds || 0;
  episode.models = mergeModels(episode.models, folder.models || []);
  episode.members = mergeMembers(episode.members, folder.members || []);

  const start = folder.created_start || null;
  const end = folder.created_end || null;
  if (start && (!episode.created_start || start < episode.created_start)) episode.created_start = start;
  if (end && (!episode.created_end || end > episode.created_end)) episode.created_end = end;
}

/** 등록 폴더 사용량을 `에피소드 → 시퀀스` 2단계로 묶는다. */
export function buildProjectUsageHierarchy(folders: ProjectFolderUsage[]): ProjectEpisodeUsage[] {
  const episodes = new Map<string, ProjectEpisodeUsage>();

  for (const folder of folders) {
    const normalizedPath = (folder.folder_path || "")
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "") || "(폴더 미지정)";
    const pathParts = normalizedPath.split("/").filter(Boolean);
    const episodeName = pathParts[0] || "(폴더 미지정)";
    const sequenceName = pathParts.length > 1 ? pathParts.slice(1).join("/") : "(직접 생성)";
    const episode = episodes.get(episodeName) || emptyEpisode(episodeName);
    const sequence: ProjectSequenceUsage = {
      ...folder,
      folder_path: normalizedPath,
      sequence_name: sequenceName,
      models: (folder.models || []).map((model) => ({ ...model })),
      members: (folder.members || []).map((member) => ({ ...member })),
    };

    episode.sequences.push(sequence);
    mergeFolderIntoEpisode(episode, sequence);
    episodes.set(episodeName, episode);
  }

  return [...episodes.values()]
    .map((episode) => ({
      ...episode,
      sequences: episode.sequences.sort((a, b) =>
        a.sequence_name.localeCompare(b.sequence_name, undefined, { numeric: true }),
      ),
    }))
    .sort((a, b) => a.episode_name.localeCompare(b.episode_name, undefined, { numeric: true }));
}
