import type { LaunchConfig } from './types.js'

/**
 * The launch a router model gets when it serves the coding `find` tool, and
 * the launch it gets when it does not.
 *
 * This is not written back onto the model's saved launch. A later one-model
 * launch of that file has to be able to chat, and an embedding process
 * cannot. Marking it here also keeps it off the GPU: auto-fit, or a
 * `--gpu-layers` left in the saved flags, would put it on the card the
 * chatting model needs.
 */
export function embeddingLaunch(config: LaunchConfig, embed: boolean): LaunchConfig {
  if (!embed) return { ...config, embed: false }
  return {
    ...config,
    embed: true,
    autoFit: false,
    gpuLayers: 0,
    parallel: 1,
    speculative: 'off',
    mmprojPath: null,
    extraArgs: ''
  }
}
