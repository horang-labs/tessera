'use client';

import { useRef, useState } from 'react';
import { ImageLightbox } from './image-lightbox';
import { useI18n } from '@/lib/i18n';

export function PreviewMarkdownImage({ src, alt, title, className }: {
  src: string;
  alt: string;
  title?: string;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const { t } = useI18n();

  return (
    <>
      {/* Keep the image inline-compatible, including inside Markdown links. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- resolved local or remote Markdown image */}
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        title={title}
        loading="lazy"
        role="button"
        tabIndex={0}
        aria-label={alt || t('chat.imageOriginalView')}
        aria-haspopup="dialog"
        className={`${className} cursor-zoom-in focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      />
      {open ? (
        <span
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ImageLightbox
            src={src}
            alt={alt}
            autoFocus
            onClose={() => {
              setOpen(false);
              imageRef.current?.focus({ preventScroll: true });
            }}
          />
        </span>
      ) : null}
    </>
  );
}
