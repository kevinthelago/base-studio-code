import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useAppStore } from '../../store';

vi.mock('../../screens/projects/previewBundle', () => ({
  bundleSkeleton: vi.fn().mockResolvedValue('BUNDLE_JS'),
  buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
  DEFAULT_IMPORTMAP: { react: 'https://esm.sh/react@18.3.1' },
  bootstrapSource: (e: string) => `import Screen from "./${e}"`,
  resolveMemPath: (_i: string, s: string) => s,
  lookupMem: () => null,
}));

// Register the html renderer so the shell can mount it.
import '../../screens/projects/preview/renderers/htmlRenderer';
import { PreviewPaneShell } from '../../screens/projects/preview/PreviewPaneShell';

describe('PreviewPaneShell (#581)', () => {
  beforeEach(() => {
    useAppStore.setState({
      stagePreview: {}, stagePipelineRuns: {}, uiScreens: {}, uiApproved: {},
    });
  });

  it('shows empty state when no preview is in the store', () => {
    render(<PreviewPaneShell projectKey="proj" />);
    expect(screen.getByText('No preview yet')).toBeTruthy();
    expect(screen.getByText('load from skeleton →')).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
  });

  it('mounts an iframe when the store has a preview for this project', async () => {
    useAppStore.setState({
      stagePreview: { proj: { srcDoc: '<html><body>STORED</body></html>', mode: '2d' } },
    });
    const { container } = render(<PreviewPaneShell projectKey="proj" />);
    // useEffect runs after render; flush it.
    await act(async () => {});
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.srcdoc).toContain('STORED');
  });

  it('does not mount an iframe for a different project key', async () => {
    useAppStore.setState({
      stagePreview: { other: { srcDoc: '<html></html>', mode: '2d' } },
    });
    const { container } = render(<PreviewPaneShell projectKey="proj" />);
    await act(async () => {});
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.getByText('No preview yet')).toBeTruthy();
  });

  it('routes a store update to the renderer without React remounting the iframe', async () => {
    useAppStore.setState({
      stagePreview: { proj: { srcDoc: '<html>A</html>', mode: '2d' } },
    });
    const { container } = render(<PreviewPaneShell projectKey="proj" />);
    await act(async () => {});
    const iframeBefore = container.querySelector('iframe')!;
    expect(iframeBefore).not.toBeNull();

    // Simulate a streaming update arriving in the store.
    act(() => {
      useAppStore.setState({
        stagePreview: { proj: { srcDoc: '<html>B</html>', mode: '2d' } },
      });
    });
    await act(async () => {});

    // Same iframe node: no React remount.
    expect(container.querySelector('iframe')).toBe(iframeBefore);
    expect(iframeBefore.srcdoc).toContain('B');
  });

  it('approve button records the current screen and toggles on re-click', async () => {
    useAppStore.setState({
      stagePreview: { proj: { srcDoc: '<html></html>', mode: '2d', screen: 'Login' } },
    });
    render(<PreviewPaneShell projectKey="proj" />);
    await act(async () => {});

    fireEvent.click(screen.getByText('approve'));
    expect(useAppStore.getState().uiApproved['proj']).toEqual(['Login']);

    fireEvent.click(screen.getByText('✓ approved'));
    expect(useAppStore.getState().uiApproved['proj']).toEqual([]);
  });

  it('does not show approve when no preview is present', () => {
    render(<PreviewPaneShell projectKey="proj" />);
    expect(screen.queryByText('approve')).toBeNull();
  });

  it('shows the declared screens list with approval count', async () => {
    useAppStore.setState({
      stagePreview: { proj: { srcDoc: '<html></html>', mode: '2d', screen: 'Login' } },
      uiScreens: { proj: ['Login', 'Dashboard'] },
      uiApproved: { proj: ['Login'] },
    });
    render(<PreviewPaneShell projectKey="proj" />);
    await act(async () => {});
    expect(screen.getByText('1/2 approved')).toBeTruthy();

    fireEvent.click(screen.getByText('Dashboard'));
    expect(useAppStore.getState().uiApproved['proj']).toEqual(['Login', 'Dashboard']);
  });

  it('multiple store updates keep one iframe in the DOM (no burst remounts)', async () => {
    useAppStore.setState({
      stagePreview: { proj: { srcDoc: '<html>0</html>', mode: '2d' } },
    });
    const { container } = render(<PreviewPaneShell projectKey="proj" />);
    await act(async () => {});

    // Simulate 5 rapid updates.
    for (let n = 1; n <= 5; n++) {
      act(() => {
        useAppStore.setState({
          stagePreview: { proj: { srcDoc: `<html>${n}</html>`, mode: '2d' } },
        });
      });
    }
    await act(async () => {});

    // Exactly one iframe in the DOM.
    expect(container.querySelectorAll('iframe').length).toBe(1);
    expect(container.querySelector('iframe')!.srcdoc).toContain('5');
  });
});
