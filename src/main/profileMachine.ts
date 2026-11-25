import { assignSensors } from '@shared/gpuReadout.js'
import { matchBackend, matchVram, type MatchMachine } from '@shared/sharedProfile.js'
import type { BinaryInfo, GpuSensor, ManagedBuild } from '@shared/types.js'
import { parseBuildNumber } from './probe.js'

/** The card a shared profile is compared with, plus a name safe to put on a form. */
export interface MachinePicture extends MatchMachine {
  name: string | null
}

/**
 * The first llama.cpp device.
 * The catalog describes one card, and a launch uses the first device unless
 * the binary is pointed at another. PCI ids come from the paired sensor.
 */
export function machineForProfiles(input: {
  binary: BinaryInfo
  managed: ManagedBuild | null
  sensors: GpuSensor[]
  driver?: string | null
}): MachinePicture {
  const devices = input.binary.devices
  const sensor = assignSensors(devices, input.sensors)[0] ?? null
  const device = devices[0] ?? null
  const managedBackend =
    input.managed && input.managed.path === input.binary.path ? input.managed.backend : null
  return {
    name: sensor?.name ?? device?.name ?? null,
    vendorId: sensor?.vendorId ?? null,
    deviceId: sensor?.deviceId ?? null,
    vramMiB: matchVram(sensor?.vramMiB ?? null, device?.totalMiB ?? null),
    backend: matchBackend({ managedBackend, deviceIds: devices.map((item) => item.id) }),
    build: parseBuildNumber(input.binary.version),
    driver: input.driver ?? null
  }
}
