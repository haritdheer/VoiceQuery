import { expect, vi } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

// Registered explicitly rather than via the side-effect entry point, so the
// matchers are attached to the same `expect` the tests use.
expect.extend(matchers);

// jsdom implements neither of these; components legitimately call both.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}
