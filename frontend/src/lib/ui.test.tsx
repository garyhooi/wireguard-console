// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyState, Panel, Skeleton, Stat, StatusBadge } from './ui'

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