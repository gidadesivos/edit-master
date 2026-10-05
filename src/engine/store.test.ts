import { beforeEach, describe, expect, it } from 'vitest';
import { addAsset, addClip, createProject, moveClip } from './project';
import { useEditor } from './store';
import { parseProject, serializeProject, ProjectParseError } from './serialize';

const asset = {
  id: 'v',
  kind: 'video' as const,
  name: 'v.mp4',
  size: 1,
  lastModified: 0,
  duration: 10,
  width: 1280,
  height: 720,
  hasAudio: true,
  hasVideo: true,
};

describe('history', () => {
  beforeEach(() => useEditor.getState().loadProject(addAsset(createProject(), asset)));

  it('undo/redo restores project states', () => {
    const s = useEditor.getState;
    s().commit((p) => addClip(p, 'v').project);
    expect(Object.keys(s().project.clips)).toHaveLength(1);
    s().undo();
    expect(Object.keys(s().project.clips)).toHaveLength(0);
    s().redo();
    expect(Object.keys(s().project.clips)).toHaveLength(1);
  });

  it('a no-op edit does not create history', () => {
    const s = useEditor.getState;
    s().commit((p) => p);
    expect(s().past).toHaveLength(0);
  });

  it('a gesture becomes a single undo step', () => {
    const s = useEditor.getState;
    let id = '';
    s().commit((p) => {
      const r = addClip(p, 'v');
      id = r.clipId;
      return r.project;
    });
    const track = s().project.clips[id].trackId;
    s().beginGesture();
    for (let i = 1; i <= 10; i++) s().gestureUpdate((base) => moveClip(base, id, track, i));
    s().endGesture();
    expect(s().project.clips[id].start).toBe(10);
    expect(s().past).toHaveLength(2);
    s().undo();
    expect(s().project.clips[id].start).toBe(0);
  });

  it('undo prunes selection of clips that no longer exist', () => {
    const s = useEditor.getState;
    let id = '';
    s().commit((p) => {
      const r = addClip(p, 'v');
      id = r.clipId;
      return r.project;
    });
    s().select([id]);
    s().undo();
    expect(s().selection).toEqual([]);
  });
});

describe('serialize', () => {
  it('round-trips a project', () => {
    const p = addClip(addAsset(createProject('x'), asset), 'v').project;
    const back = parseProject(serializeProject(p));
    expect(back).toEqual(p);
  });

  it('rejects foreign files', () => {
    expect(() => parseProject('{"hello":1}')).toThrow(ProjectParseError);
    expect(() => parseProject('not json')).toThrow(ProjectParseError);
  });

  it('repairs broken values and drops orphan clips', () => {
    const p = addClip(addAsset(createProject('x'), asset), 'v').project;
    const raw = JSON.parse(serializeProject(p));
    const clipId = Object.keys(raw.project.clips)[0];
    raw.project.clips[clipId].volume = 99;
    raw.project.clips.orphan = { id: 'orphan', assetId: 'missing', trackId: 'x' };
    raw.project.settings.fps = 'abc';
    const back = parseProject(JSON.stringify(raw));
    expect(back.clips[clipId].volume).toBe(2);
    expect(back.clips.orphan).toBeUndefined();
    expect(back.settings.fps).toBe(30);
  });
});
