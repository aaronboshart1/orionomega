/**
 * @module lib/file-types.test
 * Unit tests for MIME-type classification and file-acceptance helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  isImageType,
  isBinaryDocument,
  isTextType,
  isAcceptedFile,
  getFileIconColor,
  getFileTypeLabel,
} from './file-types';

describe('isImageType', () => {
  it('recognizes common image MIME types', () => {
    expect(isImageType('image/png')).toBe(true);
    expect(isImageType('image/jpeg')).toBe(true);
  });
  it('rejects non-image types', () => {
    expect(isImageType('application/pdf')).toBe(false);
    expect(isImageType('text/plain')).toBe(false);
  });
});

describe('isBinaryDocument', () => {
  it('recognizes PDF and Office formats', () => {
    expect(isBinaryDocument('application/pdf')).toBe(true);
    expect(
      isBinaryDocument('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe(true);
  });
  it('rejects plain text', () => {
    expect(isBinaryDocument('text/plain')).toBe(false);
  });
});

describe('isTextType', () => {
  it('treats any text/* type as text', () => {
    expect(isTextType('text/plain')).toBe(true);
    expect(isTextType('text/markdown')).toBe(true);
  });
  it('treats whitelisted application/* types as text', () => {
    expect(isTextType('application/json')).toBe(true);
  });
  it('rejects binary types', () => {
    expect(isTextType('image/png')).toBe(false);
    expect(isTextType('application/pdf')).toBe(false);
  });
});

describe('isAcceptedFile', () => {
  it('accepts a recognized MIME type', () => {
    const file = new File(['{}'], 'data.json', { type: 'application/json' });
    expect(isAcceptedFile(file)).toBe(true);
  });
  it('accepts by extension even when the MIME type is empty', () => {
    const file = new File(['# title'], 'notes.md', { type: '' });
    expect(isAcceptedFile(file)).toBe(true);
  });
  it('rejects an unknown binary file', () => {
    const file = new File([new Uint8Array([0, 1, 2])], 'mystery.bin', {
      type: 'application/octet-stream',
    });
    expect(isAcceptedFile(file)).toBe(false);
  });
});

describe('getFileIconColor', () => {
  it('maps known types to color classes and falls back for unknown', () => {
    expect(getFileIconColor('application/pdf')).toBe('text-red-400');
    expect(getFileIconColor('application/json')).toBe('text-yellow-400');
    expect(getFileIconColor('application/octet-stream')).toBe('text-zinc-400');
  });
});

describe('getFileTypeLabel', () => {
  it('produces human-readable labels', () => {
    expect(getFileTypeLabel('image/png')).toBe('Image');
    expect(getFileTypeLabel('application/pdf')).toBe('PDF');
    expect(getFileTypeLabel('application/json')).toBe('JSON');
  });
});
