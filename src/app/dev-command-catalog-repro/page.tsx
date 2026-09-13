import { notFound } from 'next/navigation';
import { CommandCatalogRepro } from './repro';

export default function CommandCatalogReproPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <CommandCatalogRepro />;
}
