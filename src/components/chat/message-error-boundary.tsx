'use client';

import { Component, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { i18n } from '@/lib/i18n';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class MessageErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error('MessageBubble rendering error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="my-2 rounded-lg px-3 py-2 bg-(--status-error-bg) border border-(--status-error-border) flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-(--status-error-text) shrink-0 mt-0.5" />
          <div className="text-xs text-(--status-error-text)">
            <div className="font-medium mb-1">{i18n.t('errors.messageRenderError')}</div>
            <div className="text-(--status-error-text) opacity-80">
              {this.state.error?.message || i18n.t('errors.unknownError')}
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
