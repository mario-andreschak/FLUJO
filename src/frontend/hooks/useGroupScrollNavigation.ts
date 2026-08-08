"use client";

import { useCallback } from 'react';
import type { RefObject } from 'react';

export function useGroupScrollNavigation<T extends HTMLElement>(ref: RefObject<T | null>) {
  const scrollToGroup = useCallback((direction: 'previous' | 'next') => {
    const container = ref.current;
    const headers = Array.from(
      (container ?? document).querySelectorAll<HTMLElement>('[data-card-group-key]'),
    );
    if (!headers.length) return;
    const currentTop = container ? container.getBoundingClientRect().top : 0;
    const positions = headers.map(header => ({
      header,
      top: header.getBoundingClientRect().top - currentTop + (container?.scrollTop ?? window.scrollY),
    }));
    const offset = container?.scrollTop ?? window.scrollY;
    const target = direction === 'previous'
      ? [...positions].reverse().find(item => item.top < offset - 4)
      : positions.find(item => item.top > offset + 4);
    if (!target) return;
    if (container) container.scrollTo({ top: target.top, behavior: 'smooth' });
    else window.scrollTo({ top: target.top, behavior: 'smooth' });
  }, [ref]);

  return {
    scrollToPreviousGroup: () => scrollToGroup('previous'),
    scrollToNextGroup: () => scrollToGroup('next'),
  };
}
