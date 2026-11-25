import { useEffect, useState } from 'react'
import { formatGpuReadout } from '@shared/gpuReadout.js'
import type { GpuSensor } from '@shared/types.js'

/** nvidia-smi is a process, so this is a couple of seconds rather than a frame. */
const POLL_MS = 2000

/**
 * Polls while the Server panel is on screen. Leaving the tab unmounts it,
 * which stops the reads.
 */
export function useGpuSensors(): GpuSensor[] {
  const [sensors, setSensors] = useState<GpuSensor[]>([])
  useEffect(() => {
    let stop = false
    let busy = false
    const tick = (): void => {
      if (busy) return
      busy = true
      void window.llama.gpu
        .sensors()
        .then((next) => {
          if (!stop) setSensors(next)
        })
        .catch(() => {
          // A missing reading leaves the VRAM line as it was.
        })
        .finally(() => {
          busy = false
        })
    }
    tick()
    const id = window.setInterval(tick, POLL_MS)
    return () => {
      stop = true
      window.clearInterval(id)
    }
  }, [])
  return sensors
}

export function GpuReadout({ sensor }: { sensor: GpuSensor }): React.JSX.Element | null {
  const { figures, note } = formatGpuReadout(sensor)
  if (!figures) return null
  return (
    <div className="mt-1">
      <p
        className="text-[11px] text-muted"
        title="Temperature, power draw against the card's limit, and graphics clock against its maximum."
      >
        {figures}
      </p>
      {note && <p className="text-[11px] text-amber-300">{note}</p>}
    </div>
  )
}
