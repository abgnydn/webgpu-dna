/**
 * WebGPU device initialization.
 *
 * WebGPU default caps `maxStorageBufferBindingSize` at 128 MiB which is
 * too small for our 192–256 MB radical/chem_pos buffers. We explicitly
 * request the adapter's max via `requiredLimits`.
 */

import type { LogFn } from '../physics/types';

export async function initGPU(log?: LogFn): Promise<GPUDevice | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    log?.('WebGPU not available in this browser.', 'err');
    return null;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    log?.('No GPU adapter found.', 'err');
    return null;
  }

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      // The primary bind group binds 9 storage buffers (rad_dep added for
      // deposit-site direct-SSB scoring); the guaranteed baseline is 8.
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    },
  });

  // Surface a lost device instead of dead-ending. A TDR / driver reset / OOM
  // fires device.lost; without this the cached device silently stops responding
  // and every later mapAsync just hangs with no user-visible reason. 'destroyed'
  // is the expected reason when we tear the device down ourselves — don't alarm.
  device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    log?.(`GPU device lost (${info.reason || 'unknown'}): ${info.message} — reload the page to recover.`, 'err');
  });
  // Validation/OOM errors that escape an explicit error scope land here.
  device.addEventListener('uncapturederror', (e) => {
    const err = (e as GPUUncapturedErrorEvent).error;
    log?.(`GPU error: ${err.message}`, 'err');
  });

  log?.(`GPU initialized: ${adapter.info?.description || 'default adapter'}`, 'ok');
  return device;
}
