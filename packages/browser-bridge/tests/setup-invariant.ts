/**
 * Execute the package's invariant companion under coverage. The stub registry
 * runs the installer like the real invariant service.
 */
import { apply } from '../src/invariant.ts'

void apply({
  invariants: {
    register: (_name: string, install: () => void) => {
      install()
      return () => {}
    },
  },
} as never)
