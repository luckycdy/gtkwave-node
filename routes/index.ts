import express from 'express'
import waves from './waves'

const router = express.Router()

router.use('/waves', waves)

export default router
