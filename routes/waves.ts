import express from 'express'
import VCDParse from '../utils/VCDParse'

const router = express.Router()
router
  .get('/:fileName/modules', async (req, res) => {
    const fileName = req.params.fileName
    const myParse = new VCDParse(`./vcd/${fileName}.vcd`)
    const data = await myParse.parseHeader()
    try {
      res.send(data)
    } catch (error) {
      res.status(500).send('Something Error')
    }
  })
  .get('/:fileName/signal', async (req, res) => {
    const fileName = req.params.fileName
    const t = Number(req.query.t)
    const myParse = new VCDParse(`./vcd/${fileName}.vcd`)
    const signal = await myParse.parseSignals(t)
    try {
      res.send(signal)
    } catch (error) {
      res.status(500).send('Something Error')
    }
  })
export default router
