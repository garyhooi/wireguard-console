// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { EmptyState, Modal, Panel, Skeleton, Stat, StatusBadge } from './ui'

describe('ui primitives', () => {
  it('Stat renders label, value and tone', () => {
    render(<Stat label="Peers" value={42} tone="good" sub="total" />)
    expect(screen.getByText('Peers')).toBeTruthy()
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.getByText('total')).toBeTruthy()
  })

  it('Stat applies tone class for positive values', () => {
    const { container } = render(<Stat label="Connected" value={3} tone="good" />)
    expect(container.querySelector('p.text-teal-400')).toBeTruthy()
  })

  it('EmptyState renders title, hint and action', () => {
    render(
      <EmptyState
        title="No peers yet"
        hint="Create a server first."
        action={<button>Add peer</button>}
      />,
    )
    expect(screen.getByText('No peers yet')).toBeTruthy()
    expect(screen.getByText('Create a server first.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add peer' })).toBeTruthy()
  })

  it('StatusBadge renders known and unknown statuses', () => {
    const { container } = render(<StatusBadge status="active" />)
    expect(screen.getByText('active')).toBeTruthy()
    expect(container.querySelector('.text-teal-400')).toBeTruthy()

    render(<StatusBadge status="mystery" />)
    expect(screen.getByText('mystery')).toBeTruthy()
  })

  it('Skeleton renders with the shimmer class', () => {
    const { container } = render(<Skeleton className="h-8 w-56" />)
    expect(container.querySelector('.wgc-skeleton')).toBeTruthy()
  })

  it('Panel renders title and children', () => {
    const { container } = render(
      <Panel title="Recent peers">
        <p>body</p>
      </Panel>,
    )
    expect(screen.getByText('Recent peers')).toBeTruthy()
    expect(container.querySelector('section')).toBeTruthy()
  })
})

describe('Modal', () => {
  it('does not steal focus from an input while typing', () => {
    // Reproduces the bug: callers pass a fresh inline onClose each render,
    // so a Modal effect keyed on [open, onClose] re-ran on every keystroke
    // and refocused the dialog, yanking the caret out of the input.
    function Harness() {
      const [open, setOpen] = useState(true)
      const [value, setValue] = useState('')
      return (
        <>
          <Modal open={open} onClose={() => setOpen(false)} title="Invite User">
            <input
              aria-label="email"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Modal>
          <p>{value}</p>
        </>
      )
    }
    render(<Harness />)
    const input = screen.getByLabelText('email') as HTMLInputElement
    input.focus()
    // Each keystroke re-renders Harness, producing a brand-new onClose
    // closure — the exact condition that used to steal focus.
    fireEvent.change(input, { target: { value: 'u' } })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: 'us' } })
    expect(document.activeElement).toBe(input)
  })

  it('closes on Escape using the latest onClose', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Modal open onClose={onClose} title="T">body</Modal>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
  })
})