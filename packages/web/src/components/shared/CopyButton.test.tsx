/**
 * @module components/shared/CopyButton.test
 * Component tests for the CopyButton — verifies the copy flow and the
 * transient "copied" confirmation state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const copyToClipboard = vi.fn<(text: string) => Promise<boolean>>();
vi.mock('@/utils/clipboard', () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}));

import { CopyButton } from './CopyButton';

beforeEach(() => {
  copyToClipboard.mockReset();
});

describe('CopyButton', () => {
  it('copies the provided text on click', async () => {
    copyToClipboard.mockResolvedValue(true);
    render(<CopyButton text="hello world" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('hello world'));
  });

  it('shows the success icon after a successful copy', async () => {
    copyToClipboard.mockResolvedValue(true);
    const { container } = render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole('button'));
    // The Check icon carries the green success color class once copied.
    await waitFor(() => expect(container.querySelector('.text-green-400')).toBeInTheDocument());
  });

  it('does not enter the success state when the copy fails', async () => {
    copyToClipboard.mockResolvedValue(false);
    const { container } = render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
    expect(container.querySelector('.text-green-400')).not.toBeInTheDocument();
  });
});
