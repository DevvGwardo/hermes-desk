import { describe, expect, it } from 'vitest'
import { chatStarters, starterLabel } from '../chat-starters'

const agent = (name: string, title?: string) => ({ name, summary: 'Private VM agent.', persona: title ? { title, description: '' } : undefined })

describe('chatStarters', () => {
  it('matches what the agent is', () => {
    expect(chatStarters(agent('Web Researcher'))[0]).toBe('Research the latest on ')
    expect(chatStarters(agent('CoderBob'))[0]).toBe('Write a script that ')
    expect(chatStarters(agent('X Growth Analyst'))[0]).toBe('Find the top posts this week about ')
    expect(chatStarters(agent('Chief', 'Chief of Staff'))[2]).toBe('What can each of my agents do?')
  })

  it('falls back to general starters, and rooms get room starters', () => {
    expect(chatStarters(agent('Nub'))).toHaveLength(3)
    expect(chatStarters(agent('Nub'))[0]).toBe('Research and summarize ')
    expect(chatStarters(null)[0]).toBe('Research and summarize ')
    expect(chatStarters(agent('CoderBob'), true)[0]).toBe('Everyone, give me your take on ')
  })
})

describe('starterLabel', () => {
  it('trails off on open-ended starters and leaves questions alone', () => {
    expect(starterLabel('Research the latest on ')).toBe('Research the latest on…')
    expect(starterLabel('Explain how this code works: ')).toBe('Explain how this code works…')
    expect(starterLabel('Analyze the recent posts from @')).toBe('Analyze the recent posts from…')
    expect(starterLabel('What can each of my agents do?')).toBe('What can each of my agents do?')
  })
})
