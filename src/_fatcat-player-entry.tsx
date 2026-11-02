// Self-contained browser entry: re-export FatCatIcon + the React copy
// esbuild inlines, so window.FatCatBundle has both `FatCatIcon` and `React`.
import * as React from 'react'
import * as ReactDOM from 'react-dom/client'
import { FatCatIcon } from './components/FatCatIcon'

export { FatCatIcon, React, ReactDOM }
