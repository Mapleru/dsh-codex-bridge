/**
 * Runtime skill registration.
 *
 * The skill body lives in `skills/codex-bridge/SKILL.md` so the same file can
 * be copied into a Codex project without duplicating prose in code.
 */
import fs from 'node:fs'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function unquote(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseSkillFile(text) {
  const match = FRONTMATTER.exec(text)
  if (!match) return { meta: {}, content: text.trim() }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (!key || !value) continue
    meta[key] = unquote(value)
  }
  return { meta, content: text.slice(match[0].length).trim() }
}

export function loadSkillFile(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const { meta, content } = parseSkillFile(text)
  if (!meta.name || !meta.description || !content) return null
  const skill = {
    name: meta.name,
    description: meta.description,
    content,
    source: file,
  }
  if (meta.whenToUse) skill.whenToUse = meta.whenToUse
  if (meta['disable-model-invocation'] === 'true') {
    skill.invocation = { modelInvocable: false, userInvocable: true }
  }
  return skill
}

export function registerSkill(ctx, file, logger) {
  const skill = loadSkillFile(file)
  if (!skill) {
    logger?.warn?.('codex-bridge skill file missing or invalid', { file })
    return null
  }
  let fiber
  try {
    fiber = ctx.inject(['skills'], (sub) => {
      const dispose = sub.skills.register(skill)
      return () => dispose?.()
    })
  } catch (error) {
    logger?.warn?.('codex-bridge skill registration unavailable', { code: error?.code ?? 'skill-error' })
    return null
  }
  return () => {
    try {
      fiber?.dispose?.()
    } catch {
      /* ignore */
    }
  }
}
