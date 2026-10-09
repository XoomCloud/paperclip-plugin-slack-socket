// Normalize generated paths only; credential, model and instruction changes still invalidate.
export function normalizeManagedAiSessionConfig(config) {
  if (!config?.managedAiConnection || typeof config.env?.HOME !== 'string') return config;
  const home=config.env.HOME;
  if(!/^\/tmp\/paperclip-ai-[a-f0-9-]+-[A-Za-z0-9]+$/.test(home))return config;
  const env={...config.env};
  for(const key of ['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','CODEX_HOME','GROK_HOME','CLAUDE_CONFIG_DIR']){
    if(env[key]===home || (typeof env[key]==='string' && env[key].startsWith(home+'/')))
      env[key]='<managed-ai-home>'+env[key].slice(home.length);
  }
  return {...config,env};
}
