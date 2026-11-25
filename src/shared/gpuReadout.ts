import type { GpuDevice, GpuSensor } from './types.js'

/**
 * Turns kernel and nvidia-smi text into the figures the Server panel shows.
 *
 * `--list-devices` is a name and a VRAM total. Temperature, power and clock
 * come from elsewhere. The PCI ids stay beside the figures so a shared profile
 * can later match this card. Nothing here fetches or stores.
 */

/** A reading further than this from a device's VRAM belongs to a different card. */
export const VRAM_MATCH_MIB = 1024

/**
 * nvidia-smi fields, in query order. `name` stays last: it is the only field
 * that can contain a comma, and the parser treats every extra column as part
 * of it.
 */
export const NVIDIA_SMI_FIELDS = [
  'temperature.gpu',
  'power.draw',
  'power.limit',
  'clocks.sm',
  'clocks.max.sm',
  'clocks_event_reasons.sw_power_cap',
  'clocks_event_reasons.hw_thermal_slowdown',
  'pci.vendor_id',
  'pci.device_id',
  'memory.total',
  'name'
] as const

export function nvidiaSmiArgs(): string[] {
  return [`--query-gpu=${NVIDIA_SMI_FIELDS.join(',')}`, '--format=csv,noheader,nounits']
}

/** `0x1002`, `0x000073FF` and a bare `73ff` all become `0x73ff`. */
export function parsePciId(text: string | null | undefined): string | null {
  if (!text) return null
  const match = /0x([0-9a-f]+)/i.exec(text.trim()) ?? /^([0-9a-f]{4})$/i.exec(text.trim())
  if (!match) return null
  const n = Number.parseInt(match[1]!, 16)
  if (!Number.isFinite(n)) return null
  return `0x${n.toString(16).padStart(4, '0')}`
}

/**
 * amdgpu's `pp_dpm_sclk`. The line with a star is the level in use. The
 * highest level is the maximum, which is how a low clock is visible. With no
 * star the current clock is unknown: the maximum must not be shown as if the
 * card were running at it.
 */
export function parsePpDpm(text: string | null): { current: number | null; max: number | null } {
  if (!text) return { current: null, max: null }
  let current: number | null = null
  let max: number | null = null
  for (const line of text.split('\n')) {
    const match = /(\d+(?:\.\d+)?)\s*mhz(\s*\*)?/i.exec(line)
    if (!match) continue
    const mhz = Number(match[1])
    if (!Number.isFinite(mhz) || mhz > 10_000) continue
    max = max === null ? mhz : Math.max(max, mhz)
    if (match[2]) current = mhz
  }
  return { current, max }
}

export function decideLimit(input: {
  tempC: number | null
  junctionC: number | null
  /** Edge critical temperature in °C, when the junction is not reported. */
  tempLimitC: number | null
  /** Junction critical temperature in °C. */
  junctionLimitC: number | null
  powerW: number | null
  powerLimitW: number | null
  thermalFlag: boolean
  powerFlag: boolean
}): GpuSensor['limit'] {
  // The hotspot is what AMD throttles on. Comparing it with the edge limit
  // would call a healthy card hot, so the edge is used only when there is no hotspot.
  const junctionHot =
    input.junctionC !== null &&
    input.junctionLimitC !== null &&
    input.junctionC >= input.junctionLimitC - 2
  const edgeHot =
    input.junctionC === null &&
    input.tempC !== null &&
    input.tempLimitC !== null &&
    input.tempC >= input.tempLimitC - 2
  const hot = input.thermalFlag || junctionHot || edgeHot
  const powered =
    input.powerFlag ||
    (input.powerW !== null &&
      input.powerLimitW !== null &&
      input.powerLimitW > 0 &&
      input.powerW >= input.powerLimitW * 0.97)
  if (hot && powered) return 'temperature-and-power'
  if (hot) return 'temperature'
  if (powered) return 'power'
  return null
}

/** One nvidia-smi csv document, one sensor per GPU line. */
export function parseNvidiaSmi(text: string): GpuSensor[] {
  const sensors: GpuSensor[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const cols = parseCsvLine(line)
    if (cols.length < NVIDIA_SMI_FIELDS.length) continue
    if (cols[0] === 'temperature.gpu') continue
    const nameIndex = NVIDIA_SMI_FIELDS.length - 1
    const head = cols.slice(0, nameIndex)
    const name = cols.slice(nameIndex).join(', ').trim()
    const cell = (field: (typeof NVIDIA_SMI_FIELDS)[number]): string => {
      if (field === 'name') return name
      return head[NVIDIA_SMI_FIELDS.indexOf(field)] ?? ''
    }
    const tempC = optionalNumber(cell('temperature.gpu'))
    const powerW = optionalNumber(cell('power.draw'))
    const powerLimitW = optionalNumber(cell('power.limit'))
    const clockMHz = optionalNumber(cell('clocks.sm'))
    const clockMaxMHz = optionalNumber(cell('clocks.max.sm'))
    if (tempC === null && powerW === null && clockMHz === null) continue
    const limit = decideLimit({
      tempC,
      junctionC: null,
      tempLimitC: null,
      junctionLimitC: null,
      powerW,
      powerLimitW,
      thermalFlag: isActive(cell('clocks_event_reasons.hw_thermal_slowdown')),
      powerFlag: isActive(cell('clocks_event_reasons.sw_power_cap'))
    })
    sensors.push({
      id: `nvidia${sensors.length}`,
      vendor: 'nvidia',
      vendorId: parsePciId(cell('pci.vendor_id')),
      deviceId: parsePciId(cell('pci.device_id')),
      name: name || null,
      vramMiB: optionalNumber(cell('memory.total')),
      tempC,
      junctionC: null,
      powerW,
      powerLimitW,
      clockMHz,
      clockMaxMHz,
      limit
    })
  }
  return sensors
}

export function formatGpuReadout(sensor: GpuSensor): { figures: string; note: string | null } {
  const parts: string[] = []
  if (sensor.tempC !== null && sensor.junctionC !== null && Math.abs(sensor.junctionC - sensor.tempC) >= 3) {
    parts.push(`${Math.round(sensor.tempC)}°C, hotspot ${Math.round(sensor.junctionC)}°C`)
  } else {
    // The edge temperature is what other monitors call the GPU temperature.
    // The hotspot is only added when it has pulled away from that.
    const temp = sensor.tempC ?? sensor.junctionC
    if (temp !== null) parts.push(`${Math.round(temp)}°C`)
  }
  if (sensor.powerW !== null) {
    parts.push(
      sensor.powerLimitW !== null
        ? `${watts(sensor.powerW)} / ${watts(sensor.powerLimitW)} W`
        : `${watts(sensor.powerW)} W`
    )
  }
  if (sensor.clockMHz !== null) {
    parts.push(
      sensor.clockMaxMHz !== null
        ? `${Math.round(sensor.clockMHz)} / ${Math.round(sensor.clockMaxMHz)} MHz`
        : `${Math.round(sensor.clockMHz)} MHz`
    )
  }
  return { figures: parts.join(' · '), note: limitNote(sensor.limit) }
}

/**
 * Pair each llama.cpp device with the sensor whose VRAM is the same card.
 * Identical cards keep list order: DRM, nvidia-smi and `--list-devices` all
 * follow PCI enumeration, so Vulkan0 stays with card0.
 * A sensor with no VRAM figure is used only when it is the only card in sight.
 */
export function assignSensors(devices: GpuDevice[], sensors: GpuSensor[]): Array<GpuSensor | null> {
  const assigned: Array<GpuSensor | null> = devices.map(() => null)
  const used = new Set<number>()
  const ranked = devices.flatMap((device, di) =>
    sensors.flatMap((sensor, si) =>
      sensor.vramMiB === null ? [] : [{ di, si, dist: Math.abs(device.totalMiB - sensor.vramMiB) }]
    )
  )
  ranked.sort((a, b) => a.dist - b.dist || a.di - b.di || a.si - b.si)
  for (const row of ranked) {
    if (row.dist > VRAM_MATCH_MIB) break
    if (assigned[row.di] !== null || used.has(row.si)) continue
    assigned[row.di] = sensors[row.si]!
    used.add(row.si)
  }
  if (
    devices.length === 1 &&
    sensors.length === 1 &&
    assigned[0] === null &&
    sensors[0]!.vramMiB === null
  ) {
    assigned[0] = sensors[0]!
  }
  return assigned
}

export function limitNote(limit: GpuSensor['limit']): string | null {
  if (limit === 'temperature') return 'At its temperature limit'
  if (limit === 'power') return 'At its power limit'
  if (limit === 'temperature-and-power') return 'At its temperature and power limits'
  return null
}

/** Split one csv line. Quotes can hold a comma; a doubled quote is a quote. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ',') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur.trim())
  return out
}

function optionalNumber(text: string): number | null {
  const cleaned = text.trim()
  if (!cleaned || /n\/a|not supported|unknown/i.test(cleaned)) return null
  const match = /-?\d+(?:\.\d+)?/.exec(cleaned)
  if (!match) return null
  const n = Number(match[0])
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

function isActive(text: string): boolean {
  return /^(active|1|yes)$/i.test(text.trim())
}

function watts(w: number): string {
  const tenths = Math.round(w * 10)
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1)
}
