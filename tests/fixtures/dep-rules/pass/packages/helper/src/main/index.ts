import { app } from 'electron'
import { ready } from '../windows.ts'
export const boot = [app, ready]
