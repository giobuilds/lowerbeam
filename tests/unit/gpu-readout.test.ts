import assert from 'node:assert/strict'
import type { GpuDevice, GpuSensor } from '@shared/types.js'
import {
  NVIDIA_SMI_FIELDS,
  assignSensors,
  decideLimit,
  formatGpuReadout,
  parseCsvLine,
  parseNvidiaSmi,
  parsePciId,
  parsePpDpm
} from '@shared/gpuReadout.js'
import { readGpuSensors, type SensorIo } from '../../src/main/gpuReadout.js'

let n = 0
const ok = (message: string, fn?: () => void): void => {
  fn?.()
  n++
  console.log('  ok', message)
}

const device = (id: string, totalMiB: number): GpuDevice => ({
  id,
  name: id,
  totalMiB,
  freeMiB: totalMiB
})

function smiRow(values: Record<(typeof NVIDIA_SMI_FIELDS)[number], string>): string {
  return NVIDIA_SMI_FIELDS.map((field) => values[field]).join(', ')
}

const QUIET: Record<(typeof NVIDIA_SMI_FIELDS)[number], string> = {
  'temperature.gpu': '45',
  'power.draw': '30.00',
  'power.limit': '170.00',
  'clocks.sm': '210',
  'clocks.max.sm': '1830',
  'clocks_event_reasons.sw_power_cap': 'Not Active',
  'clocks_event_reasons.hw_thermal_slowdown': 'Not Active',
  'pci.vendor_id': '0x10DE',
  'pci.device_id': '0x2504',
  'memory.total': '8192',
  name: 'NVIDIA GeForce RTX 3060'
}

function fakeIo(files: Record<string, string>, dirs: Record<string, string[]>, smi: string | null): SensorIo & { smiCalls: number } {
  const io = {
    smiCalls: 0,
    async read(path: string) {
      return Object.prototype.hasOwnProperty.call(files, path) ? files[path]! : null
    },
    async list(path: string) {
      return dirs[path] ?? []
    },
    async nvidiaSmi() {
      io.smiCalls++
      return smi
    }
  }
  return io
}

const RX_VRAM = String(8176 * 1024 * 1024)

function amdTree(over: Record<string, string> = {}): { files: Record<string, string>; dirs: Record<string, string[]> } {
  const base = '/sys/class/drm/card0/device'
  const files: Record<string, string> = {
    [`${base}/vendor`]: '0x1002\n',
    [`${base}/device`]: '0x73ff\n',
    [`${base}/uevent`]: 'DRIVER=amdgpu\nPCI_ID=1002:73FF\n',
    [`${base}/hwmon/hwmon2/temp1_input`]: '61000\n',
    [`${base}/hwmon/hwmon2/temp2_input`]: '78000\n',
    [`${base}/hwmon/hwmon2/temp1_crit`]: '100000\n',
    [`${base}/hwmon/hwmon2/temp2_crit`]: '110000\n',
    [`${base}/hwmon/hwmon2/power1_average`]: '78500000\n',
    [`${base}/hwmon/hwmon2/power1_cap`]: '100000000\n',
    [`${base}/pp_dpm_sclk`]: '0: 500Mhz\n1: 2044Mhz *\n',
    [`${base}/mem_info_vram_total`]: RX_VRAM,
    ...over
  }
  const dirs: Record<string, string[]> = {
    '/sys/class/drm': ['card0', 'card0-DP-1', 'renderD128'],
    [`${base}/hwmon`]: ['hwmon2']
  }
  return { files, dirs }
}

console.log('pci ids')
ok('normalises a padded id', () => {
  assert.equal(parsePciId('0x000073FF\n'), '0x73ff')
  assert.equal(parsePciId('1002'), '0x1002')
  assert.equal(parsePciId('nope'), null)
  assert.equal(parsePciId(null), null)
})

console.log('pp_dpm')
ok('the starred level is the current clock and the highest is the maximum', () => {
  assert.deepEqual(parsePpDpm('0: 500Mhz\n1: 2044Mhz *\n'), { current: 2044, max: 2044 })
})
ok('without a star the current clock is unknown', () => {
  assert.deepEqual(parsePpDpm('0: 500MHz\n1: 2000MHz\n'), { current: null, max: 2000 })
})
ok('an empty clock file is not a maximum', () => {
  assert.deepEqual(parsePpDpm(''), { current: null, max: null })
  assert.deepEqual(parsePpDpm(null), { current: null, max: null })
})

console.log('limits')
ok('power at 97 percent of the cap is the power limit', () => {
  const at = decideLimit({
    tempC: 60, junctionC: 70, tempLimitC: 100, junctionLimitC: 110,
    powerW: 97, powerLimitW: 100, thermalFlag: false, powerFlag: false
  })
  const under = decideLimit({
    tempC: 60, junctionC: 70, tempLimitC: 100, junctionLimitC: 110,
    powerW: 96, powerLimitW: 100, thermalFlag: false, powerFlag: false
  })
  assert.equal(at, 'power')
  assert.equal(under, null)
})
ok('a hotspot within 2 degrees of its own critical temperature is the temperature limit', () => {
  const hot = decideLimit({
    tempC: 70, junctionC: 108, tempLimitC: 100, junctionLimitC: 110,
    powerW: 40, powerLimitW: 100, thermalFlag: false, powerFlag: false
  })
  assert.equal(hot, 'temperature')
})
ok('a warm hotspot is not compared with the edge limit', () => {
  const fine = decideLimit({
    tempC: 99, junctionC: 90, tempLimitC: 100, junctionLimitC: 110,
    powerW: 40, powerLimitW: 100, thermalFlag: false, powerFlag: false
  })
  assert.equal(fine, null)
})
ok('a driver flag names the limit even when the numbers are under it', () => {
  assert.equal(decideLimit({
    tempC: 70, junctionC: null, tempLimitC: null, junctionLimitC: null,
    powerW: 40, powerLimitW: 100, thermalFlag: true, powerFlag: true
  }), 'temperature-and-power')
})
ok('an idle low clock is not a limit', () => {
  assert.equal(decideLimit({
    tempC: 40, junctionC: null, tempLimitC: 100, junctionLimitC: null,
    powerW: 8, powerLimitW: 100, thermalFlag: false, powerFlag: false
  }), null)
})

console.log('nvidia-smi')
ok('reads one quiet card', () => {
  const [sensor] = parseNvidiaSmi(smiRow(QUIET))
  assert.ok(sensor)
  assert.equal(sensor.vendor, 'nvidia')
  assert.equal(sensor.vendorId, '0x10de')
  assert.equal(sensor.deviceId, '0x2504')
  assert.equal(sensor.name, 'NVIDIA GeForce RTX 3060')
  assert.equal(sensor.vramMiB, 8192)
  assert.equal(sensor.tempC, 45)
  assert.equal(sensor.powerW, 30)
  assert.equal(sensor.powerLimitW, 170)
  assert.equal(sensor.clockMHz, 210)
  assert.equal(sensor.clockMaxMHz, 1830)
  assert.equal(sensor.limit, null)
  assert.equal(sensor.id, 'nvidia0')
})
ok('a quoted name may contain a comma', () => {
  const line = '62, 99, 100, 1200, 1800, Active, Not Active, 0x10DE, 0x2484, 8192, "GeForce RTX 3060, Laptop"'
  const [sensor] = parseNvidiaSmi(line)
  assert.equal(sensor?.name, 'GeForce RTX 3060, Laptop')
  assert.equal(sensor?.limit, 'power')
})
ok('Not Active is not a limit, and N/A leaves that figure out', () => {
  const [sensor] = parseNvidiaSmi(smiRow({ ...QUIET, 'power.draw': '[N/A]', 'power.limit': '[Not Supported]' }))
  assert.equal(sensor?.powerW, null)
  assert.equal(sensor?.powerLimitW, null)
  assert.equal(sensor?.tempC, 45)
  assert.equal(sensor?.limit, null)
})
ok('a thermal flag is the temperature limit', () => {
  const [sensor] = parseNvidiaSmi(smiRow({ ...QUIET, 'clocks_event_reasons.hw_thermal_slowdown': 'Active' }))
  assert.equal(sensor?.limit, 'temperature')
})
ok('a line of N/A is not a card', () => {
  const blank = NVIDIA_SMI_FIELDS.map(() => '[N/A]').join(', ')
  assert.deepEqual(parseNvidiaSmi(`${blank}\n`), [])
})
ok('two rows keep nvidia-smi order', () => {
  const text = `${smiRow(QUIET)}\n${smiRow({ ...QUIET, 'pci.device_id': '0x2204', 'memory.total': '10240' })}`
  const sensors = parseNvidiaSmi(text)
  assert.deepEqual(sensors.map((s) => s.id), ['nvidia0', 'nvidia1'])
  assert.equal(sensors[1]?.vramMiB, 10240)
})

console.log('csv')
ok('a doubled quote inside quotes is a quote', () => {
  assert.deepEqual(parseCsvLine('"say ""hi""", 1'), ['say "hi"', '1'])
})

console.log('wording')
const sample = (over: Partial<GpuSensor>): GpuSensor => ({
  id: 'card0', vendor: 'amd', vendorId: '0x1002', deviceId: '0x73ff', name: null,
  vramMiB: 8176, tempC: 61, junctionC: 78, powerW: 78.5, powerLimitW: 100,
  clockMHz: 1850, clockMaxMHz: 2044, limit: null, ...over
})
ok('shows edge, hotspot, power against the cap, and clock against the maximum', () => {
  assert.equal(formatGpuReadout(sample({})).figures, '61°C, hotspot 78°C · 78.5 / 100 W · 1850 / 2044 MHz')
  assert.equal(formatGpuReadout(sample({})).note, null)
})
ok('a hotspot within 3 degrees of the edge is just the edge temperature', () => {
  assert.equal(formatGpuReadout(sample({ tempC: 78, junctionC: 80 })).figures.startsWith('78°C ·'), true)
})
ok('uses the hotspot when the edge was not reported', () => {
  assert.equal(formatGpuReadout(sample({ tempC: null, junctionC: 80 })).figures.startsWith('80°C ·'), true)
})
ok('names the limit in words', () => {
  assert.equal(formatGpuReadout(sample({ limit: 'power' })).note, 'At its power limit')
  assert.equal(formatGpuReadout(sample({ limit: 'temperature' })).note, 'At its temperature limit')
  assert.equal(formatGpuReadout(sample({ limit: 'temperature-and-power' })).note, 'At its temperature and power limits')
})
ok('omits a figure the driver did not report', () => {
  assert.equal(
    formatGpuReadout(sample({ junctionC: null, powerW: null, powerLimitW: null, clockMaxMHz: null })).figures,
    '61°C · 1850 MHz'
  )
})

console.log('pairing')
ok('pairs a card whose VRAM is a few MiB off and refuses a different card', () => {
  const sensors: GpuSensor[] = [sample({}), sample({ id: 'card1', vramMiB: 4096, deviceId: '0x164e' })]
  const paired = assignSensors([device('Vulkan0', 8192), device('Vulkan1', 4096)], sensors)
  assert.equal(paired[0]?.id, 'card0')
  assert.equal(paired[1]?.id, 'card1')
  const far = assignSensors([device('Vulkan0', 2048)], [sample({})])
  assert.equal(far[0], null)
})
ok('identical cards keep list order', () => {
  const sensors = [sample({ id: 'card0' }), sample({ id: 'card1' })]
  const paired = assignSensors([device('Vulkan0', 8176), device('Vulkan1', 8176)], sensors)
  assert.deepEqual(paired.map((s) => s?.id), ['card0', 'card1'])
})
ok('a sensor with no VRAM figure is used only when it is the only card', () => {
  const lone = sample({ vramMiB: null })
  assert.equal(assignSensors([device('Vulkan0', 8176)], [lone])[0]?.id, 'card0')
  assert.deepEqual(assignSensors([device('Vulkan0', 8176), device('Vulkan1', 4096)], [lone]), [null, null])
})

console.log('amd sysfs')
{
  const { files, dirs } = amdTree()
  const io = fakeIo(files, dirs, 'should-not-run')
  const sensors = await readGpuSensors(io)
  ok('reads an RX 6600 class card and ignores the connector node', () => {
    assert.equal(io.smiCalls, 0)
    assert.equal(sensors.length, 1)
    const card = sensors[0]!
    assert.equal(card.id, 'card0')
    assert.equal(card.vendor, 'amd')
    assert.equal(card.vendorId, '0x1002')
    assert.equal(card.deviceId, '0x73ff')
    assert.equal(card.tempC, 61)
    assert.equal(card.junctionC, 78)
    assert.equal(card.powerW, 78.5)
    assert.equal(card.powerLimitW, 100)
    assert.equal(card.clockMHz, 2044)
    assert.equal(card.clockMaxMHz, 2044)
    assert.equal(card.vramMiB, 8176)
    assert.equal(card.limit, null)
  })
}
{
  const { files, dirs } = amdTree({
    '/sys/class/drm/card0/device/hwmon/hwmon2/power1_average': '99000000\n',
    '/sys/class/drm/card0/device/hwmon/hwmon2/temp2_input': '109000\n'
  })
  const [card] = await readGpuSensors(fakeIo(files, dirs, null))
  ok('a card on both published limits says so', () => {
    assert.equal(card?.limit, 'temperature-and-power')
  })
}
{
  const { files, dirs } = amdTree({
    '/sys/class/drm/card0/device/pp_dpm_sclk': '0: 500Mhz\n1: 2000Mhz\n',
    '/sys/class/drm/card0/device/hwmon/hwmon2/freq1_input': '1500000000\n',
    '/sys/class/drm/card0/device/hwmon/hwmon2/power1_average': 'nope\n'
  })
  const [card] = await readGpuSensors(fakeIo(files, dirs, null))
  ok('uses the hwmon frequency when no level is starred, and a bad power file is absent', () => {
    assert.equal(card?.clockMHz, 1500)
    assert.equal(card?.clockMaxMHz, 2000)
    assert.equal(card?.powerW, null)
  })
}

console.log('nvidia command')
{
  const files: Record<string, string> = {
    '/sys/class/drm/card1/device/vendor': '0x10de\n',
    '/sys/class/drm/card1/device/device': '0x2504\n',
    '/sys/class/drm/card1/device/uevent': 'DRIVER=nvidia\n',
    '/sys/class/drm/card1/device/hwmon/hwmon0/temp1_input': '99000\n'
  }
  const dirs = {
    '/sys/class/drm': ['card1'],
    '/sys/class/drm/card1/device/hwmon': ['hwmon0']
  }
  const io = fakeIo(files, dirs, smiRow(QUIET))
  const [card] = await readGpuSensors(io)
  ok('prefers nvidia-smi over the hwmon temperature', () => {
    assert.equal(io.smiCalls, 1)
    assert.equal(card?.id, 'nvidia0')
    assert.equal(card?.tempC, 45)
    assert.equal(card?.name, 'NVIDIA GeForce RTX 3060')
  })
}
{
  const files: Record<string, string> = {
    '/sys/class/drm/card1/device/vendor': '0x10de\n',
    '/sys/class/drm/card1/device/device': '0x2504\n',
    '/sys/class/drm/card1/device/uevent': 'DRIVER=nouveau\n',
    '/sys/class/drm/card1/device/hwmon/hwmon0/temp1_input': '55000\n'
  }
  const dirs = {
    '/sys/class/drm': ['card1'],
    '/sys/class/drm/card1/device/hwmon': ['hwmon0']
  }
  const [card] = await readGpuSensors(fakeIo(files, dirs, null))
  ok('nouveau keeps the hwmon temperature when nvidia-smi is missing', () => {
    assert.equal(card?.id, 'card1')
    assert.equal(card?.vendor, 'nvidia')
    assert.equal(card?.tempC, 55)
    assert.equal(card?.clockMHz, null)
    assert.equal(card?.powerW, null)
  })
}
{
  const io = fakeIo({}, { '/sys/class/drm': [] }, smiRow(QUIET))
  const [card] = await readGpuSensors(io)
  ok('with no DRM node, nvidia-smi is still asked', () => {
    assert.equal(io.smiCalls, 1)
    assert.equal(card?.vendorId, '0x10de')
  })
}
{
  const io = fakeIo({}, { '/sys/class/drm': ['card0'] }, 'should-not-run')
  const sensors = await readGpuSensors(io)
  ok('an unrelated card is neither AMD nor NVIDIA and does not run nvidia-smi', () => {
    assert.equal(io.smiCalls, 0)
    assert.deepEqual(sensors, [])
  })
}

console.log(`\n${n} assertions passed`)
