import { notFound } from 'next/navigation';
import { ScrollAutoscrollReproClient } from './scroll-autoscroll-repro-client';

export default function ScrollAutoscrollReproPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound();
  }

  return <ScrollAutoscrollReproClient />;
}
