function captureFlowApproval(approval) {
  if (!approval) return null;
  return {
    modelId: approval.modelId,
    modelLabel: approval.modelLabel,
    modelSource: approval.modelSource,
  };
}

export function captureSceneEnqueueContext({ project, episode, source, scenes, kind, target, provider, flowModelApproval } = {}) {
  const approval = captureFlowApproval(flowModelApproval);
  return {
    slug: project?.slug,
    episodeCode: episode?.code,
    episodeTitle: episode?.title || '',
    scenes: structuredClone(Array.isArray(scenes) ? scenes : []),
    source,
    kind,
    target,
    provider,
    ...(approval ? { flowModelApproval: approval } : {}),
  };
}

export function captureQueueAllContext({ project, provider, episodes, flowModelApproval } = {}) {
  const approval = captureFlowApproval(flowModelApproval);
  return {
    project: { slug: project?.slug, name: project?.name || project?.slug || '' },
    provider,
    episodes: (Array.isArray(episodes) ? episodes : []).map((episode) => ({
      code: episode?.episode_code || episode?.code,
      title: episode?.title || '',
    })),
    ...(approval ? { flowModelApproval: approval } : {}),
  };
}

export function captureStandaloneEnqueueContext({ prompts, label, provider } = {}) {
  return {
    prompts: [...(Array.isArray(prompts) ? prompts : [])],
    label,
    provider,
  };
}
