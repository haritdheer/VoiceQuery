import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

/**
 * Registers jest-dom's matcher types.
 *
 * The bundled `@testing-library/jest-dom/vitest` augmentation targets a
 * single-parameter `Assertion<T>`, but in Vitest 5 `expect()` resolves to
 * Chai's two-parameter `Assertion`, so that augmentation no longer merges.
 * Declaring it against Chai's interface here is what actually applies.
 * The matchers themselves are attached in setup.ts.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Chai {
    interface Assertion extends TestingLibraryMatchers<unknown, void> {}
  }
}

export {};
