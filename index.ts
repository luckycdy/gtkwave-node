import express, { json, urlencoded } from 'express'
import logger from 'morgan'
import cors from 'cors'
import router from './routes/index'

const app = express()
// 解决跨域
app.use(cors())
// 以 dev 模式记录日志
app.use(logger('dev'))
// 可以接收 json 数据类型
app.use(json())
// 可以接收表单的发送数据
app.use(urlencoded({ extended: false }))
app.use('/api', router)

export default app
