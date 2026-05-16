import { Router, type IRouter } from "express";
import healthRouter from "./health";
import filesRouter from "./files";
import homeRouter from "./home";
import broadcastsRouter from "./broadcasts";

const router: IRouter = Router();

router.use(healthRouter);
router.use(filesRouter);
router.use(broadcastsRouter);

export default router;

export { homeRouter };
