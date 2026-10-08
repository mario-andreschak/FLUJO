/**
 * Group-anchor test for CollapsibleCardSection (issue #376).
 *
 * "Jump to the previous/next folder" resolves its targets with a single DOM
 * query, so the header must expose a stable, queryable anchor on every list
 * page (Models / MCP / Flows / Automations).
 */
import React from 'react';
import { render } from '@testing-library/react';
import CollapsibleCardSection from '@/frontend/components/shared/CollapsibleCardSection';

describe('CollapsibleCardSection anchors (#376)', () => {
  it('exposes the group key as a scroll anchor and a stable id', () => {
    const { container } = render(
      <CollapsibleCardSection label="Local" count={2} expanded onToggle={jest.fn()} groupKey="folder:local">
        <div>content</div>
      </CollapsibleCardSection>,
    );

    const anchor = container.querySelector('[data-scroll-group-key]');
    expect(anchor).not.toBeNull();
    expect(anchor).toHaveAttribute('data-scroll-group-key', 'folder:local');
    expect(anchor).toHaveAttribute('id', 'scroll-group-folder:local');
  });

  it('prefers an explicit anchorKey over the group key', () => {
    const { container } = render(
      <CollapsibleCardSection
        label="Local"
        count={2}
        expanded
        onToggle={jest.fn()}
        groupKey="folder:local"
        anchorKey="custom"
      >
        <div>content</div>
      </CollapsibleCardSection>,
    );

    expect(container.querySelector('[data-scroll-group-key]')).toHaveAttribute('data-scroll-group-key', 'custom');
  });

  it('renders no anchor attribute when the section is ungrouped', () => {
    const { container } = render(
      <CollapsibleCardSection label="All" count={1} expanded onToggle={jest.fn()}>
        <div>content</div>
      </CollapsibleCardSection>,
    );

    expect(container.querySelector('[data-scroll-group-key]')).toBeNull();
  });

  it('keeps the header (and therefore the anchor) mounted while collapsed', () => {
    const { container } = render(
      <CollapsibleCardSection label="Local" count={2} expanded={false} onToggle={jest.fn()} groupKey="g1">
        <div>content</div>
      </CollapsibleCardSection>,
    );

    expect(container.querySelectorAll('[data-scroll-group-key]')).toHaveLength(1);
  });
});
