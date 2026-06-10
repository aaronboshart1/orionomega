/**
 * @module components/shared/TabGroup.test
 * Component tests for the reusable TabGroup tablist.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabGroup, type TabDef } from './TabGroup';

const tabs: TabDef[] = [
  { key: 'one', label: 'One' },
  { key: 'two', label: 'Two' },
  { key: 'three', label: 'Three' },
];

describe('TabGroup', () => {
  it('renders one tab per definition with a tablist role', () => {
    render(<TabGroup tabs={tabs} active="one" onSelect={() => {}} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('marks the active tab via aria-selected', () => {
    render(<TabGroup tabs={tabs} active="two" onSelect={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onSelect with the tab key on click', () => {
    const onSelect = vi.fn();
    render(<TabGroup tabs={tabs} active="one" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Three' }));
    expect(onSelect).toHaveBeenCalledWith('three');
  });

  it('renders an icon and badge when provided', () => {
    const withExtras: TabDef[] = [
      { key: 'a', label: 'Alpha', icon: <span data-testid="icon">*</span>, badge: <span data-testid="badge">9</span> },
    ];
    render(<TabGroup tabs={withExtras} active="a" onSelect={() => {}} />);
    expect(screen.getByTestId('icon')).toBeInTheDocument();
    expect(screen.getByTestId('badge')).toBeInTheDocument();
  });
});
