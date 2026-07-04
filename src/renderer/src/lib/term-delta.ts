export type WritePlan =
  | { kind: 'none' }
  | { kind: 'full'; text: string; written: number }
  | { kind: 'delta'; text: string; written: number }

export function computeWriteDelta(prevWritten: number, output: string): WritePlan {
  if (output.length < prevWritten) {
    return { kind: 'full', text: output, written: output.length }
  }
  if (output.length > prevWritten) {
    return { kind: 'delta', text: output.slice(prevWritten), written: output.length }
  }
  return { kind: 'none' }
}
