export function captureSceneEnqueueContext({ project, episode, source, scenes, kind, target, provider } = {}) {
  return {
    slug: project?.slug,
    episodeCode: episode?.code,
    episodeTitle: episode?.title || '',
    scenes: structuredClone(Array.isArray(scenes) ? scenes : []),
    source,
    kind,
    target,
    provider,
  };
}

export function captureQueueAllContext({ project, provider, episodes } = {}) {
  return {
    project: { slug: project?.slug, name: project?.name || project?.slug || '' },
    provider,
    episodes: (Array.isArray(episodes) ? episodes : []).map((episode) => ({
      code: episode?.episode_code || episode?.code,
      title: episode?.title || '',
    })),
  };
}

export function captureStandaloneEnqueueContext({ prompts, label, provider } = {}) {
  return {
    prompts: [...(Array.isArray(prompts) ? prompts : [])],
    label,
    provider,
  };
}
