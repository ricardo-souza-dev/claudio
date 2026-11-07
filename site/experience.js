// A deliberately illustrative walkthrough, not a recording of an API response.
const descriptions = [
  'Tudo começa na sua pasta. O projeto é o ponto de partida para qualquer modelo.',
  'Arquivos lidos e ferramentas usadas fazem parte do histórico. O contexto acompanha o trabalho.',
  'Outro modelo assume com o mesmo histórico e as mesmas ferramentas. Você continua, sem explicar tudo de novo.'
]

export function initWalkthrough(doc = document) {
  const stage = doc.getElementById('demonstracao')
  const interaction = stage?.querySelector('.demo-interaction')
  const description = doc.getElementById('demo-description')
  const tabs = Array.from(stage?.querySelectorAll('[role="tab"]') ?? [])
  if (!stage || !interaction || !description || tabs.length !== descriptions.length) return

  function select(index, focus = false) {
    stage.dataset.activeStep = String(index)
    tabs.forEach((tab, position) => {
      tab.setAttribute('aria-selected', String(position === index))
      tab.tabIndex = position === index ? 0 : -1
    })
    description.textContent = descriptions[index]
    description.setAttribute('aria-labelledby', tabs[index].id)
    if (focus) tabs[index].focus()
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index))
    tab.addEventListener('keydown', (event) => {
      let next
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
      if (event.key === 'Home') next = 0
      if (event.key === 'End') next = tabs.length - 1
      if (next === undefined) return
      event.preventDefault()
      select(next, true)
    })
  })
  select(0)
  interaction.hidden = false
}

if (typeof document !== 'undefined') initWalkthrough()
