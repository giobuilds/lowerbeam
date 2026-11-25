import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import {
  decideLimit,
  nvidiaSmiArgs,
  parsePciId,
  parsePpDpm,
  parseNvidiaSmi
} from '@shared/gpuReadout.js'
import type { GpuSensor } from '@shared/types.js'

/**
 * Reads a card's temperature, power and clock from this machine.
 *
 * AMD publishes them on the amdgpu hwmon and pp_dpm files, which are
 * world-readable. NVIDIA's proprietary driver answers nvidia-smi. nouveau
 * only has the hwmon temperature, and that is what we show when nvidia-smi
 * is missing. Nothing here is written to disk.
 *
 * The methods must not throw. A missing file is null, a missing directory is
 * an empty list, and a missing nvidia-smi is null.
 */
export interface SensorIo {
  read(path: string): Promise<string | null>
  list(path: string): Promise<string[]>
  nvidiaSmi(): Promise<string | null>
}

const DRM = '/sys/class/drm'

interface CardRef {
  card: string
  driver: string
  vendorId: string | null
  deviceId: string | null
}

export async function readGpuSensors(io: SensorIo): Promise<GpuSensor[]> {
  const entries = await io.list(DRM)
  const cards = entries
    .filter((name) => /^card\d+$/.test(name))
    .sort((a, b) => cardIndex(a) - cardIndex(b))
  const refs: CardRef[] = []
  for (const card of cards) {
    const base = `${DRM}/${card}/device`
    const [vendorText, deviceText, uevent] = await Promise.all([
      io.read(`${base}/vendor`),
      io.read(`${base}/device`),
      io.read(`${base}/uevent`)
    ])
    refs.push({
      card,
      driver: /^DRIVER=(.*)$/m.exec(uevent ?? '')?.[1]?.trim() ?? '',
      vendorId: parsePciId(vendorText),
      deviceId: parsePciId(deviceText)
    })
  }

  const sensors: GpuSensor[] = []
  const nvidia: CardRef[] = []
  for (const ref of refs) {
    const kind = cardKind(ref)
    if (kind === 'amd') {
      const sensor = await readCard(io, ref, 'amd')
      if (sensor) sensors.push(sensor)
    } else if (kind === 'nvidia') {
      nvidia.push(ref)
    }
  }

  // No DRM node at all still tries nvidia-smi: the proprietary driver does
  // not always publish a card node before the first modeset. An AMD-only
  // machine does not pay for that process.
  if (nvidia.length > 0 || cards.length === 0) {
    const text = await io.nvidiaSmi()
    const fromSmi = text ? parseNvidiaSmi(text) : []
    if (fromSmi.length > 0) {
      sensors.push(...fromSmi)
    } else {
      for (const ref of nvidia) {
        const sensor = await readCard(io, ref, 'nvidia')
        if (sensor) sensors.push(sensor)
      }
    }
  }
  return sensors
}

let pending: Promise<GpuSensor[]> | null = null

/**
 * One read at a time. The panel polls every couple of seconds, and nvidia-smi
 * is a process: a second call while the first is still running would stack.
 */
export function readHostGpuSensors(): Promise<GpuSensor[]> {
  if (pending) return pending
  pending = readGpuSensors(hostSensorIo()).finally(() => {
    pending = null
  })
  return pending
}

export function hostSensorIo(): SensorIo {
  return {
    async read(path) {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    async list(path) {
      try {
        return await readdir(path)
      } catch {
        return []
      }
    },
    nvidiaSmi() {
      return runNvidiaSmi()
    }
  }
}

/**
 * Packaged builds often have a short PATH. Try the usual location after the
 * name, and treat a failure as "no NVIDIA reading" rather than an error.
 */
async function runNvidiaSmi(): Promise<string | null> {
  const args = nvidiaSmiArgs()
  for (const bin of ['nvidia-smi', '/usr/bin/nvidia-smi']) {
    const out = await exec(bin, args)
    if (out !== null) return out
  }
  return null
}

function exec(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2500, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

function cardKind(ref: CardRef): 'amd' | 'nvidia' | null {
  if (ref.driver === 'amdgpu' || (ref.vendorId === '0x1002' && ref.driver !== 'nvidia' && ref.driver !== 'nouveau')) {
    return 'amd'
  }
  if (ref.driver === 'nvidia' || ref.driver === 'nouveau' || ref.vendorId === '0x10de') return 'nvidia'
  return null
}

function cardIndex(card: string): number {
  return Number(/^card(\d+)$/.exec(card)?.[1] ?? 0)
}

async function readCard(io: SensorIo, ref: CardRef, vendor: 'amd' | 'nvidia'): Promise<GpuSensor | null> {
  const base = `${DRM}/${ref.card}/device`
  const hwmonNames = await io.list(`${base}/hwmon`)
  const hwmon = hwmonNames.find((name) => /^hwmon\d+$/.test(name))
  const h = hwmon ? `${base}/hwmon/${hwmon}` : null
  const [temp1, temp2, temp1Crit, temp2Crit, powerText, capText, freqText, sclkText, vramText] = await Promise.all([
    h ? io.read(`${h}/temp1_input`) : null,
    h ? io.read(`${h}/temp2_input`) : null,
    h ? io.read(`${h}/temp1_crit`) : null,
    h ? io.read(`${h}/temp2_crit`) : null,
    h ? io.read(`${h}/power1_average`) : null,
    h ? io.read(`${h}/power1_cap`) : null,
    h ? io.read(`${h}/freq1_input`) : null,
    io.read(`${base}/pp_dpm_sclk`),
    io.read(`${base}/mem_info_vram_total`)
  ])
  const dpm = parsePpDpm(sclkText)
  // hwmon power is microwatts, temperature millidegrees, freq hertz.
  // pp_dpm is already MHz. A missing file stays null.
  const tempC = milliC(temp1)
  const junctionC = milliC(temp2)
  const powerW = microW(powerText)
  const powerLimitW = microW(capText)
  const clockMHz = dpm.current ?? freqMhz(freqText)
  const clockMaxMHz = dpm.max
  if (tempC === null && junctionC === null && powerW === null && clockMHz === null) return null
  return {
    id: ref.card,
    vendor,
    vendorId: ref.vendorId,
    deviceId: ref.deviceId,
    name: null,
    vramMiB: vramBytesToMiB(vramText),
    tempC,
    junctionC,
    powerW,
    powerLimitW,
    clockMHz,
    clockMaxMHz,
    limit: decideLimit({
      tempC,
      junctionC,
      tempLimitC: milliC(temp1Crit),
      junctionLimitC: milliC(temp2Crit),
      powerW,
      powerLimitW,
      thermalFlag: false,
      powerFlag: false
    })
  }
}

/** hwmon `temp*_input` is millidegrees Celsius. */
function milliC(text: string | null): number | null {
  const n = firstNumber(text)
  if (n === null) return null
  const c = n / 1000
  return c <= 200 ? c : null
}

/** hwmon `power1_*` is microwatts. */
function microW(text: string | null): number | null {
  const n = firstNumber(text)
  if (n === null) return null
  const w = n / 1e6
  return w <= 2000 ? w : null
}

/**
 * hwmon `freq1_input` is hertz. A value this small was already in MHz, which
 * a few kernels have printed; either way the panel shows MHz.
 */
function freqMhz(text: string | null): number | null {
  const n = firstNumber(text)
  if (n === null) return null
  const mhz = n >= 1_000_000 ? n / 1e6 : n
  return mhz <= 10_000 ? mhz : null
}

/** `mem_info_vram_total` is bytes. */
function vramBytesToMiB(text: string | null): number | null {
  const n = firstNumber(text)
  if (n === null) return null
  return Math.round(n / (1024 * 1024))
}

function firstNumber(text: string | null): number | null {
  if (!text) return null
  const match = /-?\d+(?:\.\d+)?/.exec(text.trim())
  if (!match) return null
  const n = Number(match[0])
  if (!Number.isFinite(n) || n < 0) return null
  return n
}
