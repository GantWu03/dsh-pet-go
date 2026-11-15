import { PROTOCOL_VERSION } from '@dsh-pet-go/shared/protocol'
import { dsh } from './adapters/dsh.ts'
export const wired = [PROTOCOL_VERSION, dsh]
