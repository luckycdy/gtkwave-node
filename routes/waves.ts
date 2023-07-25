import express from 'express'
import VCDParse from '../utils/VCDParse'

const router = express.Router()
router
  .get('/:fileName/header', async (req, res) => {
    const fileName = req.params.fileName
    const myParse = new VCDParse(`./vcd/${fileName}.vcd`)
    const data = await myParse.parseHeader()
    try {
      res.send(data)
    } catch (error) {
      res.status(500).send('Something Error')
    }
  })
  .post('/:fileName/signal', async (req, res) => {
    const fileName = req.params.fileName
    const s = req.body['signals']
    console.log('signals is', s)

    const myParse = new VCDParse(`./vcd/${fileName}.vcd`)
    const signal = await myParse.parseSignal(s)
    try {
      res.send(signal)
    } catch (error) {
      res.status(500).send('Something Error')
    }
  })
export default router
