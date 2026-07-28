/**
 * Compile WGSL shaders and create GPU compute pipelines.
 * Mirrors makePipes() from geant4dna.html.
 */
import { assemblePrimaryShader, assembleSecondaryShader, getChemistryShader } from '../shaders/loader';
import type { GPUBuffers } from './buffers';

export interface Pipelines {
  primary: GPUComputePipeline;
  secondary: GPUComputePipeline;
  chemDiffuse: GPUComputePipeline;
  chemReact: GPUComputePipeline;
  chemMatch: GPUComputePipeline;
  chemClearHash: GPUComputePipeline;
  chemBuildHash: GPUComputePipeline;
  chemCount: GPUComputePipeline;
  chemSample: GPUComputePipeline;
  chemInit: GPUComputePipeline;
  primaryBG: GPUBindGroup;
  secondaryBG: GPUBindGroup;
  chemBG: GPUBindGroup;
}

async function compileShader(
  device: GPUDevice,
  code: string,
  label: string,
): Promise<GPUShaderModule> {
  device.pushErrorScope('validation');
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const err = await device.popErrorScope();
  if (info.messages.length || err) {
    const msgs = info.messages.map(m => `L${m.lineNum}: ${m.message.slice(0, 200)}`).join('\n');
    throw new Error(`${label} shader compilation failed:\n${msgs}\n${err?.message ?? ''}`);
  }
  return module;
}

export async function createPipelines(
  device: GPUDevice,
  buffers: GPUBuffers,
): Promise<Pipelines> {
  // Compile shaders
  const primarySrc = await assemblePrimaryShader();
  const secondarySrc = await assembleSecondaryShader();
  const chemSrc = getChemistryShader();

  const primaryMod = await compileShader(device, primarySrc, 'primary');
  const secondaryMod = await compileShader(device, secondarySrc, 'secondary');
  const chemMod = await compileShader(device, chemSrc, 'chemistry');

  // Primary bind group layout (8 bindings)
  const primaryLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });

  const ppl = device.createPipelineLayout({ bindGroupLayouts: [primaryLayout] });

  const primaryBG = device.createBindGroup({
    layout: primaryLayout,
    entries: [
      { binding: 0, resource: { buffer: buffers.params } },
      { binding: 1, resource: { buffer: buffers.results } },
      { binding: 2, resource: { buffer: buffers.rng } },
      { binding: 3, resource: { buffer: buffers.dbg } },
      { binding: 4, resource: { buffer: buffers.radBuf } },
      { binding: 5, resource: { buffer: buffers.secBuf } },
      { binding: 6, resource: { buffer: buffers.dose } },
      { binding: 7, resource: { buffer: buffers.counters } },
      { binding: 8, resource: { buffer: buffers.radE } },
    ],
  });

  // Secondary bind group layout (7 bindings)
  const secLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });

  const spl = device.createPipelineLayout({ bindGroupLayouts: [secLayout] });

  const secondaryBG = device.createBindGroup({
    layout: secLayout,
    entries: [
      { binding: 0, resource: { buffer: buffers.secParams } },
      { binding: 1, resource: { buffer: buffers.secBuf } },
      { binding: 2, resource: { buffer: buffers.secStats } },
      { binding: 3, resource: { buffer: buffers.dose } },
      { binding: 4, resource: { buffer: buffers.counters } },
      { binding: 5, resource: { buffer: buffers.radBuf } },
      { binding: 6, resource: { buffer: buffers.radE } },
    ],
  });

  // Chemistry bind group layout (8 bindings)
  const chemLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });

  const cpl = device.createPipelineLayout({ bindGroupLayouts: [chemLayout] });

  const chemBG = device.createBindGroup({
    layout: chemLayout,
    entries: [
      { binding: 0, resource: { buffer: buffers.chemUni } },
      { binding: 1, resource: { buffer: buffers.chemPos } },
      { binding: 2, resource: { buffer: buffers.chemAlive } },
      { binding: 3, resource: { buffer: buffers.chemRng } },
      { binding: 4, resource: { buffer: buffers.chemStats } },
      { binding: 5, resource: { buffer: buffers.radBuf } },
      { binding: 6, resource: { buffer: buffers.chemCellHead } },
      { binding: 7, resource: { buffer: buffers.chemNextIdx } },
      { binding: 8, resource: { buffer: buffers.chemPosOld } },
    ],
  });

  const mkPipe = (layout: GPUPipelineLayout, mod: GPUShaderModule, entry: string) =>
    device.createComputePipeline({ layout, compute: { module: mod, entryPoint: entry } });

  return {
    primary: mkPipe(ppl, primaryMod, 'main'),
    secondary: mkPipe(spl, secondaryMod, 'step'),
    chemDiffuse: mkPipe(cpl, chemMod, 'diffuse'),
    chemReact: mkPipe(cpl, chemMod, 'react'),
    chemMatch: mkPipe(cpl, chemMod, 'match_react'),
    chemClearHash: mkPipe(cpl, chemMod, 'clear_hash'),
    chemBuildHash: mkPipe(cpl, chemMod, 'build_hash'),
    chemCount: mkPipe(cpl, chemMod, 'count_alive'),
    chemSample: mkPipe(cpl, chemMod, 'sample_init'),
    chemInit: mkPipe(cpl, chemMod, 'init_thermal'),
    primaryBG,
    secondaryBG,
    chemBG,
  };
}
