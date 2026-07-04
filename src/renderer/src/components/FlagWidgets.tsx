import { useState } from 'react'
import type { Flag } from '../../../shared/types'

interface WidgetProps {
  flag: Flag
  value: unknown
  onChange: (v: unknown) => void
}

export function FlagField({ flag, value, onChange }: WidgetProps): JSX.Element {
  switch (flag.type) {
    case 'bool':
      return <BoolWidget flag={flag} value={value} onChange={onChange} />
    case 'int':
    case 'float':
      return <NumberWidget flag={flag} value={value} onChange={onChange} />
    case 'stringSlice':
      return <TagWidget flag={flag} value={value} onChange={onChange} />
    default:
      return <TextWidget flag={flag} value={value} onChange={onChange} />
  }
}

function Label({ flag }: { flag: Flag }): JSX.Element {
  return (
    <label className="flag-label" title={flag.usage}>
      <span className="flag-name">--{flag.name}</span>
      {flag.shorthand && <span className="flag-short">-{flag.shorthand}</span>}
      <span className="flag-type">{flag.type}</span>
    </label>
  )
}

function BoolWidget({ flag, value, onChange }: WidgetProps): JSX.Element {
  return (
    <div className="flag-row">
      <Label flag={flag} />
      <input
        type="checkbox"
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flag-usage">{flag.usage}</span>
    </div>
  )
}

function TextWidget({ flag, value, onChange }: WidgetProps): JSX.Element {
  return (
    <div className="flag-row">
      <Label flag={flag} />
      <input
        type="text"
        className="flag-input"
        placeholder={flag.usage}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function NumberWidget({ flag, value, onChange }: WidgetProps): JSX.Element {
  return (
    <div className="flag-row">
      <Label flag={flag} />
      <input
        type="number"
        className="flag-input"
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
      <span className="flag-usage">{flag.usage}</span>
    </div>
  )
}

function TagWidget({ flag, value, onChange }: WidgetProps): JSX.Element {
  const [draft, setDraft] = useState('')
  const items = Array.isArray(value) ? (value as string[]) : []
  const commit = () => {
    const v = draft.trim()
    if (v === '') return
    onChange([...items, v])
    setDraft('')
  }
  return (
    <div className="flag-row">
      <Label flag={flag} />
      <div className="tag-field">
        {items.map((it, i) => (
          <span key={`${it}-${i}`} className="chip">
            {it}
            <button
              className="chip-x"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
            >
              x
            </button>
          </span>
        ))}
        <input
          type="text"
          className="tag-input"
          placeholder={flag.usage}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Backspace' && draft === '' && items.length > 0) {
              onChange(items.slice(0, -1))
            }
          }}
          onBlur={commit}
        />
      </div>
    </div>
  )
}
