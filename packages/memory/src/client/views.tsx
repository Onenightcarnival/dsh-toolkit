import { FIELDS, type Entry, type Kind } from '../model.ts'
import { t, type Key } from './locales.ts'

export function entryName(entry?: Entry): string {
  if (!entry) return t('none')
  if (entry.kind === 'profile') return t('personal')
  if (entry.kind === 'work') return [entry.fields.organization, entry.fields.jobTitle].filter(Boolean).join(' · ') || t('work')
  return entry.fields.title || t(entry.kind)
}
interface ViewProps {
  entries: Entry[]
  edit: (entry: Entry) => void
  remove: (entry: Entry) => void
  add: (kind: Kind, parentId?: string) => void
  open: (id: string) => void
}
function Fields({ entry, keys }: { entry: Entry; keys: readonly string[] }): JSX.Element {
  return <dl>{entry.legacyPeriod && keys.includes('startDate') && <div className="mem-detail"><dt>{t('legacyPeriod')}</dt><dd>{entry.legacyPeriod}</dd></div>}{keys.map(key => <div className="mem-detail" key={key}><dt>{t(key as Key)}</dt><dd>{key === 'endDate' && entry.fields[key] === 'present' ? t('present') : entry.fields[key] || '—'}</dd></div>)}</dl>
}
const period = (entry: Entry) => entry.legacyPeriod || (entry.kind === 'episode' ? entry.fields.date : [entry.fields.startDate, entry.fields.endDate === 'present' ? t('present') : entry.fields.endDate].filter(Boolean).join(' — ')) || '—'
function Actions({ entry, edit, remove }: Pick<ViewProps, 'edit' | 'remove'> & { entry: Entry }): JSX.Element {
  return <div className="mem-actions"><button onClick={() => edit(entry)}>{t('edit')}</button>{entry.kind !== 'profile' && <button className="mem-danger" onClick={() => remove(entry)}>{t('remove')}</button>}</div>
}
export function ResumeView(props: ViewProps): JSX.Element {
  const { entries, edit, add, remove, open } = props
  const profile = entries.find(e => e.kind === 'profile')!
  return <div className="mem-paper-stage"><article className="mem-resume mem-paper">
    <section className="mem-profile"><div className="mem-section-heading"><h2>{t('personal')}</h2><Actions entry={profile} edit={edit} remove={remove}/></div><Fields entry={profile} keys={FIELDS.profile}/></section>
    {(['work', 'project'] as const).map(kind => <section className="mem-section" key={kind}>
      <div className="mem-section-heading"><h2>{t(kind)}</h2><button onClick={() => add(kind)}>+ {t('add')}</button></div>
      {!entries.some(e => e.kind === kind) && <p className="mem-empty">{t(kind === 'work' ? 'emptyWork' : 'emptyProject')}</p>}
      {entries.filter(e => e.kind === kind).map(entry => <article className="mem-experience" key={entry.id}>
        <div className="mem-section-heading"><div><time>{period(entry)}</time><h3>{kind === 'work' ? entry.fields.organization || t('none') : entry.fields.title}</h3><p className="mem-muted">{kind === 'work' ? entry.fields.jobTitle : entry.fields.role}</p></div><Actions entry={entry} edit={edit} remove={remove}/></div>
        <Fields entry={entry} keys={['highlights']}/>
        <button className="mem-link" onClick={() => open(entry.id)}>{t(kind === 'work' ? 'viewProjects' : 'episodes')} <span>{entries.filter(e => kind === 'work' ? e.kind === 'project' && e.fields.workId === entry.id : e.kind === 'episode' && e.fields.parentId === entry.id).length}</span> →</button>
      </article>)}
    </section>)}
  </article></div>
}

export function DirectoryView(props: ViewProps & { selected: string }): JSX.Element {
  const { entries, selected, open, edit, remove, add } = props
  const independentId = '@independent'
  const profile = entries.find(e => e.kind === 'profile')!
  const independentGroup = selected === independentId
  const current = entries.find(e => e.id === selected) ?? profile
  const parent = current.kind === 'episode' ? entries.find(e => e.id === current.fields.parentId) : current.kind === 'project' ? entries.find(e => e.id === current.fields.workId) : undefined
  const project = current.kind === 'project' ? current : parent?.kind === 'project' ? parent : undefined
  const work = current.kind === 'work' ? current : parent?.kind === 'work' ? parent : project ? entries.find(e => e.id === project.fields.workId) : undefined
  const independent = independentGroup || !!project && !work
  const works = entries.filter(e => e.kind === 'work')
  const projects = entries.filter(e => e.kind === 'project' && (work ? e.fields.workId === work.id : independent && !e.fields.workId))
  const episodeParent = project ?? work
  const episodes = episodeParent ? entries.filter(e => e.kind === 'episode' && e.fields.parentId === episodeParent.id) : []
  const path = [work, project, current.kind === 'episode' ? current : undefined].filter((e): e is Entry => !!e)
  const column = (kind: 'work' | 'project' | 'episode', items: Entry[], activeId: string | undefined, empty: Key, onAdd?: () => void) => <section className={`mem-column mem-column-${kind}`} aria-label={t(kind)}>
    <header><h2>{t(kind)}</h2><button aria-label={t(kind === 'work' ? 'addWork' : kind === 'project' ? 'addProject' : 'addEpisode')} disabled={!onAdd} onClick={onAdd}>+</button></header>
    <nav className="mem-column-list" aria-label={t(kind)}>
      {items.map(entry => <button key={entry.id} className="mem-column-item" data-selected={entry.id === activeId || undefined} aria-current={entry.id === current.id && !independentGroup} onClick={() => open(entry.id)}>
        <span><strong>{entryName(entry)}</strong><time>{period(entry)}</time></span><span className="mem-column-arrow" aria-hidden="true">{entry.kind === 'episode' ? '·' : '›'}</span>
      </button>)}
      {!items.length && <p className="mem-empty">{t(empty)}</p>}
      {kind === 'work' && <button className="mem-column-item mem-independent" data-selected={independent || undefined} aria-current={independentGroup} onClick={() => open(independentId)}><span><strong>{t('noWork')}</strong><small>{entries.filter(e => e.kind === 'project' && !e.fields.workId).length}</small></span><span aria-hidden="true">›</span></button>}
    </nav>
  </section>
  return <div className="mem-directory" data-level={independentGroup ? 'work' : current.kind}>
    <div className="mem-directory-bar"><button className="mem-global" aria-pressed={current.kind === 'profile' && !independentGroup} onClick={() => open(profile.id)}>{t('personal')}</button>
      <nav className="mem-breadcrumbs" aria-label={t('path')}><button className="mem-link" onClick={() => open(profile.id)}>{t('directory')}</button>{independent && <span> / <button className="mem-link" onClick={() => open(independentId)}>{t('noWork')}</button></span>}{path.map(entry => <span key={entry.id}> / <button className="mem-link" aria-current={entry.id === current.id ? 'page' : undefined} onClick={() => open(entry.id)}>{entryName(entry)}</button></span>)}</nav>
    </div>
    <div className="mem-columns">
      {column('work', works, work?.id, 'emptyWork', () => add('work'))}
      {column('project', projects, project?.id, work || independent ? 'emptyProject' : 'selectWork', work || independent ? () => add('project', work?.id) : undefined)}
      {column('episode', episodes, current.kind === 'episode' ? current.id : undefined, project || episodes.length ? 'emptyEpisodes' : 'selectProject', project ? () => add('episode', project.id) : undefined)}
      <article className="mem-directory-detail" aria-label={t('content')}>
        {independentGroup ? <><div className="mem-section-heading"><h2>{t('noWork')}</h2><button onClick={() => add('project')}>+ {t('add')}</button></div><p className="mem-muted">{t('selectProject')}</p></> : <>
          <div className="mem-detail-type">{t(current.kind === 'profile' ? 'personal' : current.kind)}</div>
          <div className="mem-section-heading"><div><h2>{entryName(current)}</h2>{current.createdAt && <p className="mem-muted">{t('createdAt')} · {new Date(current.createdAt).toLocaleString()}</p>}</div><Actions entry={current} edit={edit} remove={remove}/></div>
          <div className={current.kind === 'profile' ? 'mem-profile' : ''}><Fields entry={current} keys={FIELDS[current.kind].filter(key => !['parentId', 'workId'].includes(key))}/></div>
          {current.kind === 'work' && !!episodes.length && <button className="mem-link" onClick={() => open(episodes[0].id)}>{t('legacyEpisodes')} · {episodes.length} →</button>}
        </>}
      </article>
    </div>
  </div>
}
