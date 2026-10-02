import type { AutomationErrorCode } from './contracts';

export class AutomationInputError extends Error {
  constructor(readonly code: AutomationErrorCode, message: string) {
    super(message);
    this.name = 'AutomationInputError';
  }
}
